import { domainToASCII } from "node:url";
import { AppError, asError, errorData, usage } from "./errors.js";
import {
  type CheckInput,
  checkInputSchema,
  type DomainResult,
  type Envelope,
  type Extension,
  type ExtensionsInput,
  extensionsInputSchema,
  extensionsSchema,
  querySchema,
  type SearchInput,
  searchInputSchema,
  success,
} from "./schema.js";

export function normalizeDomain(input: string): string {
  const value = input.trim().replace(/\.$/, "");
  if (!value || /[\s/:@?#%\\]/u.test(value)) usage("Provide domain names, not URLs or paths.");
  const ascii = domainToASCII(value).toLowerCase();
  const labels = ascii.split(".");
  if (
    ascii.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1) ?? "")
  )
    usage("Provide a valid domain name with an extension.");
  return ascii;
}

export function normalizeExtension(value: string): string {
  const extension = value.trim().replace(/^\./, "");
  return normalizeDomain(`placeholder.${extension}`).slice("placeholder.".length);
}

export function csv(value: string, max: number): string[] {
  const list = value.split(",").map((part) => part.trim());
  if (!list.length || list.length > max || list.some((part) => !part)) {
    usage(`Provide between 1 and ${max} nonempty comma-separated values.`);
  }
  return [...new Set(list)];
}

export function expandName(name: string, extensions: readonly string[]): string[] {
  const label = name.trim();
  if (!label || /[.\u3002\uff0e\uff61]/u.test(label))
    usage("A name must be a single domain label, such as brand.");
  return extensions.map((extension) =>
    normalizeDomain(`${label}.${normalizeExtension(extension)}`),
  );
}

/** Extensions a bare name is checked across, most commonly wanted first. */
export const DEFAULT_EXTENSIONS = [
  "com",
  "io",
  "ai",
  "app",
  "dev",
  "co",
  "net",
  "shop",
  "store",
  "online",
  "site",
  "info",
] as const;

/** Resolve a check request, given as complete domains or as one name, into normalized domains. */
export function checkTargets({ domains, name, extensions }: CheckInput): string[] {
  if ((domains === undefined) === (name === undefined))
    usage("Provide exactly one of domains or name.");
  if (domains === undefined)
    return [...new Set(expandName(name ?? "", extensions ?? DEFAULT_EXTENSIONS))];
  if (extensions !== undefined) usage("Extensions apply only to a name.");
  return [...new Set(domains.map(normalizeDomain))];
}

/** Every upstream operation the domain layer builds on. */
export interface Registrar {
  check(domains: string[], signal: AbortSignal): Promise<DomainResult[]>;
  search(input: SearchInput, signal: AbortSignal): Promise<DomainResult[]>;
  extensions(
    input: ExtensionsInput,
    signal: AbortSignal,
  ): Promise<{ extensions: Extension[]; cursor: string | null }>;
}

/** What every operation returns: one envelope plus the status to exit with. */
export interface Outcome {
  envelope: Envelope;
  exitCode: number;
}

export async function checkDomains(
  input: unknown,
  registrar: Registrar,
  signal: AbortSignal,
): Promise<Outcome> {
  const parsed = checkInputSchema.safeParse(input);
  if (!parsed.success) usage("Check accepts 1–100 domains, or one name with 1–100 extensions.");
  const domains = checkTargets(parsed.data);
  const results: DomainResult[] = [];
  let failure: AppError | undefined;
  for (let offset = 0; offset < domains.length; offset += 20) {
    const batch = domains.slice(offset, offset + 20);
    try {
      signal.throwIfAborted();
      // A rejected credential or an exhausted quota will not fix itself mid-run.
      if (failure && ["AUTH_REQUIRED", "FORBIDDEN", "RATE_LIMITED"].includes(failure.code))
        throw failure;
      const found = await registrar.check(batch, signal);
      const mapped = new Map(found.map((result) => [result.domain, result]));
      for (const domain of batch) {
        const result = mapped.get(domain);
        if (result) results.push(result);
        else {
          failure = new AppError("INCOMPLETE_RESPONSE", "Cloudflare omitted this domain.", 1, true);
          results.push(unknownResult(domain, failure));
        }
      }
    } catch (error) {
      failure = asError(signal.aborted ? signal.reason : error);
      const reason = failure;
      results.push(...batch.map((domain) => unknownResult(domain, reason)));
    }
  }
  const data = querySchema.parse({
    operation: "check",
    source: "cloudflare",
    checkedAt: new Date().toISOString(),
    authoritative: true,
    cache: "none",
    count: results.length,
    requestedCount: domains.length,
    truncated: false,
    cursor: null,
    domains: results,
  });
  if (!failure) return { envelope: success(data), exitCode: 0 };
  const interrupted = [124, 130, 143].includes(failure.exitCode);
  const finalError =
    !interrupted && results.some((result) => !result.error)
      ? new AppError(
          "PARTIAL_FAILURE",
          "Some domain checks failed; inspect each result.",
          1,
          failure.retryable,
        )
      : failure;
  return {
    envelope: { schemaVersion: 1, ok: false, error: errorData(finalError), data },
    exitCode: finalError.exitCode,
  };
}

function unknownResult(domain: string, error: AppError): DomainResult {
  return {
    domain,
    registrable: null,
    status: "unknown",
    reason: null,
    tier: null,
    pricing: null,
    checkedAt: new Date().toISOString(),
    sourceUrl: "https://developers.cloudflare.com/api/resources/registrar/methods/check/",
    error: errorData(error),
  };
}

export async function searchDomains(
  input: unknown,
  registrar: Registrar,
  signal: AbortSignal,
): Promise<Outcome> {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) usage("Search needs a 1–100 character query and a limit between 1 and 50.");
  const domains = await registrar.search(parsed.data, signal);
  return {
    envelope: success(
      querySchema.parse({
        operation: "search",
        source: "cloudflare",
        checkedAt: new Date().toISOString(),
        authoritative: false,
        cache: "upstream",
        count: domains.length,
        requestedCount: null,
        // Cloudflare does not say whether more suggestions exist.
        truncated: null,
        cursor: null,
        domains,
      }),
    ),
    exitCode: 0,
  };
}

export async function listExtensions(
  input: unknown,
  registrar: Registrar,
  signal: AbortSignal,
): Promise<Outcome> {
  const parsed = extensionsInputSchema.safeParse(input);
  if (!parsed.success) usage("Extensions accepts a limit of 1–50 and a 1–256 character cursor.");
  const page = await registrar.extensions(parsed.data, signal);
  return {
    envelope: success(
      extensionsSchema.parse({
        operation: "extensions",
        source: "cloudflare",
        checkedAt: new Date().toISOString(),
        count: page.extensions.length,
        cursor: page.cursor,
        truncated: Boolean(page.cursor),
        extensions: page.extensions,
      }),
    ),
    exitCode: 0,
  };
}

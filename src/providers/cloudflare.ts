import { z } from "zod";
import type { Registrar } from "../core/domains.js";
import { AppError } from "../core/errors.js";
import {
  type DomainResult,
  domainSchema,
  type ExtensionsInput,
  type SearchInput,
} from "../core/schema.js";
import { type Fetch, requestJson } from "./http.js";

const money = z.string().regex(/^\d+(?:\.\d+)?$/);
const wireDomain = z.object({
  name: z.string(),
  registrable: z.boolean(),
  reason: z.string().optional(),
  tier: z.enum(["standard", "premium"]).optional(),
  pricing: z
    .object({ currency: z.string(), registration_cost: money, renewal_cost: money })
    .optional(),
});
const wireDomains = z.object({ domains: z.array(wireDomain).max(100) });
const accountSchema = z.string().regex(/^[a-fA-F0-9]{32}$/);

export class Cloudflare implements Registrar {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {
    if (!accountSchema.safeParse(accountId).success)
      throw new AppError(
        "CONFIG_INVALID",
        "Cloudflare account ID must contain 32 hexadecimal characters.",
        2,
      );
  }

  async request(path: string, signal: AbortSignal, body?: unknown, params?: URLSearchParams) {
    // The only allowed Registrar write-shaped request is the read-only domain check.
    if (
      !["domain-check", "domain-search", "extensions"].includes(path) ||
      (body !== undefined && path !== "domain-check")
    ) {
      throw new AppError("INVALID_OPERATION", "Only Registrar query operations are supported.");
    }
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/registrar/${path}`,
    );
    if (params) url.search = params.toString();
    return apiResult(
      await requestJson(
        url,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        signal,
        this.fetcher,
      ),
    );
  }

  async check(domains: string[], signal: AbortSignal) {
    const result = await this.request("domain-check", signal, { domains });
    return parseDomains(result.result, "check");
  }

  async search(input: SearchInput, signal: AbortSignal) {
    const params = new URLSearchParams({ q: input.query, limit: String(input.limit) });
    for (const extension of input.extensions ?? []) params.append("extensions", extension);
    const result = await this.request("domain-search", signal, undefined, params);
    return parseDomains(result.result, "search");
  }

  async extensions(input: ExtensionsInput, signal: AbortSignal) {
    const params = new URLSearchParams({ per_page: String(input.limit) });
    if (input.cursor) params.set("cursor", input.cursor);
    const result = await this.request("extensions", signal, undefined, params);
    const parsed = z
      .array(z.object({ metadata: z.object({ name: z.string(), tld: z.string() }) }))
      .max(50)
      .safeParse(result.result);
    if (!parsed.success)
      throw new AppError("INVALID_RESPONSE", "Cloudflare returned invalid extension metadata.");
    const info = z.object({ cursor: z.string() }).safeParse(result.result_info);
    if (!info.success)
      throw new AppError("INVALID_RESPONSE", "Cloudflare omitted extension pagination metadata.");
    return {
      extensions: parsed.data.map((item) => ({
        extension: item.metadata.name,
        tld: item.metadata.tld,
      })),
      // An empty cursor is Cloudflare's way of saying this was the final page.
      cursor: info.data.cursor || null,
    };
  }
}

export function apiResult(value: unknown) {
  const result = z
    .object({ success: z.boolean(), result: z.unknown(), result_info: z.unknown().optional() })
    .safeParse(value);
  if (!result.success)
    throw new AppError("INVALID_RESPONSE", "Cloudflare returned an invalid API envelope.");
  if (!result.data.success)
    throw new AppError("UPSTREAM_ERROR", "Cloudflare reported an unsuccessful operation.");
  return result.data;
}

function parseDomains(value: unknown, operation: "search" | "check"): DomainResult[] {
  const parsed = wireDomains.safeParse(value);
  if (!parsed.success)
    throw new AppError("INVALID_RESPONSE", "Cloudflare returned invalid domain results.");
  const seen = new Set<string>();
  return parsed.data.domains.map((domain) => {
    const name = domain.name.toLowerCase();
    if (seen.has(name))
      throw new AppError("INVALID_RESPONSE", "Cloudflare returned duplicate domain results.");
    seen.add(name);
    const reason = domain.reason ?? null;
    const status = domain.registrable
      ? "available"
      : reason === "domain_premium"
        ? "premium"
        : reason?.startsWith("extension_not_supported")
          ? "unsupported"
          : reason === "extension_disallows_registration"
            ? "restricted"
            : reason === "domain_unavailable"
              ? "unavailable"
              : "unknown";
    return domainSchema.parse({
      domain: name,
      registrable: domain.registrable,
      status,
      reason,
      tier: domain.tier ?? null,
      pricing: domain.pricing
        ? {
            currency: domain.pricing.currency,
            registration: domain.pricing.registration_cost,
            renewal: domain.pricing.renewal_cost,
          }
        : null,
      checkedAt: new Date().toISOString(),
      sourceUrl: `https://developers.cloudflare.com/api/resources/registrar/methods/${operation}/`,
    });
  });
}

const API = "https://api.cloudflare.com/client/v4";

export interface Account {
  id: string;
  name: string;
}

/**
 * Confirm a bearer token and report its id.
 *
 * User API tokens verify at /user/tokens/verify. Account-owned tokens are
 * rejected there and verify under their own account instead, so the caller
 * retries with an account once one is known.
 */
export async function verifyApiToken(
  token: string,
  signal: AbortSignal,
  accountId?: string,
  fetcher: Fetch = fetch,
): Promise<{ id: string; status: string }> {
  const url = new URL(
    accountId ? `${API}/accounts/${accountId}/tokens/verify` : `${API}/user/tokens/verify`,
  );
  const result = apiResult(
    await requestJson(url, { headers: { Authorization: `Bearer ${token}` } }, signal, fetcher),
  );
  const parsed = z.object({ id: z.string(), status: z.string() }).safeParse(result.result);
  if (!parsed.success)
    throw new AppError("INVALID_RESPONSE", "Cloudflare returned an invalid token verification.");
  if (parsed.data.status !== "active")
    throw new AppError(
      "AUTH_FAILED",
      `Cloudflare reports this API token as ${parsed.data.status}.`,
      1,
      false,
      "Create a new token, or re-enable the existing one in the Cloudflare dashboard.",
    );
  return parsed.data;
}

/**
 * List accounts the credential can see.
 *
 * A token scoped only to Registrar has no Account Settings read permission and
 * gets an empty list rather than an error, so callers must be ready to ask for
 * the account id instead of treating this as authoritative.
 */
export async function listAccounts(
  token: string,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<Account[]> {
  const url = new URL(`${API}/accounts?per_page=50`);
  const result = apiResult(
    await requestJson(url, { headers: { Authorization: `Bearer ${token}` } }, signal, fetcher),
  );
  const parsed = z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(50)
    .safeParse(result.result);
  return parsed.success
    ? parsed.data.filter((account) => accountSchema.safeParse(account.id).success)
    : [];
}

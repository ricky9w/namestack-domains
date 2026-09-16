import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import {
  checkDomains,
  checkTargets,
  DEFAULT_EXTENSIONS,
  listExtensions,
  type Outcome,
  type Registrar,
  searchDomains,
} from "../core/domains.js";
import { asError, errorData } from "../core/errors.js";
import { domainSchema, errorSchema, extensionSchema } from "../core/schema.js";

/** Every query is a read of an external registry, and repeating one is harmless. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** The CLI envelope, narrowed to one tool's payload so outputSchema stays strict. */
function envelopeOf<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ schemaVersion: z.literal(1), ok: z.literal(true), data }),
    z.strictObject({
      schemaVersion: z.literal(1),
      ok: z.literal(false),
      error: errorSchema,
      // A partial batch still returns every per-domain result alongside the error.
      data: data.optional(),
    }),
  ]);
}

const resultBase = {
  operation: z.string(),
  source: z.literal("cloudflare"),
  checkedAt: z.string(),
  count: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  truncated: z.boolean().nullable(),
};
const domainResult = z.strictObject({
  ...resultBase,
  authoritative: z.boolean(),
  cache: z.string(),
  requestedCount: z.number().int().nonnegative().nullable(),
  domains: z.array(domainSchema),
});
const extensionsResult = z.strictObject({
  ...resultBase,
  extensions: z.array(extensionSchema),
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Encode one core operation.
 *
 * An operational failure comes back as `isError` with the same envelope the CLI
 * prints, so the server keeps serving instead of terminating the connection.
 */
async function encode(operation: () => Promise<Outcome>): Promise<ToolResult> {
  let envelope: Outcome["envelope"];
  try {
    envelope = (await operation()).envelope;
  } catch (error) {
    envelope = { schemaVersion: 1, ok: false, error: errorData(asError(error)) };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.ok ? {} : { isError: true }),
  };
}

/** Supplies the upstream client per call, so the transport decides where credentials come from. */
export type RegistrarSource = (signal: AbortSignal) => Promise<Registrar>;

export function createServer(registrar: RegistrarSource): McpServer {
  const server = new McpServer(
    { name: "namestack-domains", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "domains_check",
    {
      title: "Check domain availability",
      description:
        "Check domains against the registry in real time, given either complete domains or one name to try across extensions. Returns registrability, a reason when a domain is unavailable, and first-year and renewal pricing.",
      inputSchema: z.object({
        domains: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Complete domain names, for example brand.com. Omit when passing name."),
        name: z
          .string()
          .min(1)
          .max(63)
          .optional()
          .describe("One domain label, for example brand. Omit when passing domains."),
        extensions: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe(`Extensions to try name with. Defaults to ${DEFAULT_EXTENSIONS.join(", ")}.`),
      }),
      outputSchema: envelopeOf(domainResult),
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      encode(async () => {
        // Resolve the targets before credentials, so a bad request is reported as such.
        const domains = checkTargets(input);
        return checkDomains({ domains }, await registrar(ctx.mcpReq.signal), ctx.mcpReq.signal);
      }),
  );

  server.registerTool(
    "domains_search",
    {
      title: "Suggest domain names",
      description:
        "Suggest registrable domains for a keyword or phrase using Cloudflare's cached search data. Suggestions are not authoritative; confirm a candidate with domains_check.",
      inputSchema: z.object({
        query: z.string().min(1).max(100).describe("A keyword, phrase, or full domain."),
        extensions: z
          .array(z.string())
          .max(50)
          .optional()
          .describe(
            "Restrict suggestions to these extensions. Cloudflare may ignore unsupported ones.",
          ),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: envelopeOf(domainResult),
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      encode(async () =>
        searchDomains(input, await registrar(ctx.mcpReq.signal), ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    "domains_extensions",
    {
      title: "List supported extensions",
      description:
        "List one page of the domain extensions this API supports. Follow the returned cursor for the next page; a null cursor is the final page.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(50),
        cursor: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe("Opaque cursor from the previous page."),
      }),
      outputSchema: envelopeOf(extensionsResult),
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      encode(async () =>
        listExtensions(input, await registrar(ctx.mcpReq.signal), ctx.mcpReq.signal),
      ),
  );

  return server;
}

import { z } from "zod";

export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  hint: z.string().optional(),
  retryAfterSeconds: z.number().nonnegative().optional(),
});
export const pricingSchema = z.strictObject({
  currency: z.string(),
  registration: z.string(),
  renewal: z.string(),
});
export const domainSchema = z.strictObject({
  domain: z.string(),
  registrable: z.boolean().nullable(),
  status: z.enum(["available", "unavailable", "premium", "unsupported", "restricted", "unknown"]),
  reason: z.string().nullable(),
  tier: z.enum(["standard", "premium"]).nullable(),
  pricing: pricingSchema.nullable(),
  // Kept per domain because a partial batch can straddle retries and deadlines.
  checkedAt: z.iso.datetime(),
  sourceUrl: z.url(),
  error: errorSchema.optional(),
});
export const extensionSchema = z.strictObject({
  /** Full registrable suffix, which may hold several labels such as `co.uk`. */
  extension: z.string(),
  tld: z.string(),
});

/** Fields every query result carries, whatever it returns. */
const resultBase = {
  source: z.literal("cloudflare"),
  checkedAt: z.iso.datetime(),
  count: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  truncated: z.boolean().nullable(),
};
export const querySchema = z.strictObject({
  ...resultBase,
  operation: z.enum(["check", "search"]),
  authoritative: z.boolean(),
  cache: z.enum(["none", "upstream"]),
  requestedCount: z.number().int().nonnegative().nullable(),
  domains: z.array(domainSchema),
});
export const extensionsSchema = z.strictObject({
  ...resultBase,
  operation: z.literal("extensions"),
  extensions: z.array(extensionSchema),
});
export const envelopeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ schemaVersion: z.literal(1), ok: z.literal(true), data: z.unknown() }),
  z.strictObject({
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    error: errorSchema,
    data: z.unknown().optional(),
  }),
]);

export const checkInputSchema = z
  .strictObject({
    domains: z.array(z.string()).min(1).max(100).optional(),
    name: z.string().optional(),
    extensions: z.array(z.string()).min(1).max(100).optional(),
  })
  .describe("Provide exactly one of domains or name; extensions applies only to name.");
export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(100),
  extensions: z.array(z.string()).max(50).optional(),
  limit: z.number().int().min(1).max(50),
});
export const extensionsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(50),
  cursor: z.string().min(1).max(256).optional(),
});

export type CheckInput = z.infer<typeof checkInputSchema>;
export type DomainResult = z.infer<typeof domainSchema>;
export type Extension = z.infer<typeof extensionSchema>;
export type QueryResult = z.infer<typeof querySchema>;
export type ExtensionsResult = z.infer<typeof extensionsSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type ExtensionsInput = z.infer<typeof extensionsInputSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export function success(data: unknown): Envelope {
  return envelopeSchema.parse({ schemaVersion: 1, ok: true, data });
}

/** JSON Schema for every public input and result, for agents and scripts. */
export function describeSchemas(): Record<string, unknown> {
  const published = {
    checkInput: checkInputSchema,
    searchInput: searchInputSchema,
    extensionsInput: extensionsInputSchema,
    queryResult: querySchema,
    extensionsResult: extensionsSchema,
    envelope: envelopeSchema,
  };
  return Object.fromEntries(
    Object.entries(published).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  );
}

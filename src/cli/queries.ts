import {
  checkDomains,
  checkTargets,
  csv,
  listExtensions,
  normalizeExtension,
  type Outcome,
  searchDomains,
} from "../core/domains.js";
import { usage } from "../core/errors.js";
import { describeSchemas, success } from "../core/schema.js";
import { integer } from "./args.js";
import { type Context, registrar, stringOption, type Values } from "./context.js";
import { withProgress } from "./output.js";

export async function check(values: Values, context: Context): Promise<Outcome> {
  const names = stringOption(values, "domains");
  const name = stringOption(values, "name");
  const extensions = stringOption(values, "extensions");
  if ((names === undefined) === (name === undefined))
    usage("Use exactly one of --domains or --name.");
  if (names !== undefined && extensions !== undefined)
    usage("--extensions is only valid with --name.");
  // Resolve the targets before credentials, so a bad name is a usage error either way.
  const domains = checkTargets(
    names !== undefined
      ? { domains: csv(names, 100) }
      : { name, ...(extensions === undefined ? {} : { extensions: csv(extensions, 100) }) },
  );
  const provider = await registrar(values, context.signal);
  return withProgress(context.view, context.signal, "Checking domain availability", () =>
    checkDomains({ domains }, provider, context.signal),
  );
}

export async function search(values: Values, context: Context): Promise<Outcome> {
  const extensions = stringOption(values, "extensions");
  const input = {
    query: stringOption(values, "query"),
    limit: integer(values.limit, "limit", 20, 1, 50),
    ...(extensions === undefined
      ? {}
      : { extensions: csv(extensions, 50).map(normalizeExtension) }),
  };
  const provider = await registrar(values, context.signal);
  return withProgress(context.view, context.signal, "Finding domain suggestions", () =>
    searchDomains(input, provider, context.signal),
  );
}

export async function extensions(values: Values, context: Context): Promise<Outcome> {
  const cursor = stringOption(values, "cursor");
  const input = {
    limit: integer(values.limit, "limit", 50, 1, 50),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const provider = await registrar(values, context.signal);
  return withProgress(context.view, context.signal, "Listing supported extensions", () =>
    listExtensions(input, provider, context.signal),
  );
}

export function schema(): Outcome {
  return { envelope: success(describeSchemas()), exitCode: 0 };
}

export async function doctor(values: Values, context: Context): Promise<Outcome> {
  if (values.online) return check({ ...values, domains: "example.com" }, context);
  return (await import("./authentication.js")).status();
}

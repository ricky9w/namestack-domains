import { type ParseArgsConfig, parseArgs } from "node:util";
import type { ArgsDef } from "citty";
import { usage } from "../core/errors.js";

export const commonArgs = {
  help: { type: "boolean", alias: "h", description: "Show command help." },
  version: { type: "boolean", alias: "v", description: "Show the installed version." },
  format: {
    type: "enum",
    options: ["auto", "json", "human"],
    default: "auto",
    description: "Choose output format.",
  },
  input: {
    type: "boolean",
    default: true,
    negativeDescription: "Disable interactive input and browser login.",
  },
  color: { type: "boolean", default: true, negativeDescription: "Disable terminal colors." },
  quiet: { type: "boolean", description: "Suppress progress output." },
  timeout: {
    type: "string",
    description: "Set the total deadline in seconds (queries: 30; login: 180).",
  },
  "env-file": {
    type: "string",
    description: "Load an explicit dotenv file without overriding the environment.",
  },
} satisfies ArgsDef;
export const accountArgs = {
  "account-id": { type: "string", description: "Select a Cloudflare account ID." },
} satisfies ArgsDef;

export function nativeOptions(definitions: ArgsDef) {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.type === "positional") continue;
    const alias =
      "alias" in definition && typeof definition.alias === "string" ? definition.alias : undefined;
    options[name] = {
      type: definition.type === "boolean" ? "boolean" : "string",
      ...(alias ? { short: alias } : {}),
    };
  }
  return options;
}

export function validateArgs(rawArgs: string[], definitions: ArgsDef) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: nativeOptions(definitions),
      strict: true,
      allowPositionals: true,
      allowNegative: true,
      tokens: true,
    });
  } catch (error) {
    usage(error instanceof Error ? error.message : "Invalid arguments.");
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    const name = token.name.startsWith("no-") ? token.name.slice(3) : token.name;
    if (seen.has(name)) usage(`Option --${name} may only be supplied once.`);
    seen.add(name);
  }
  const allowed = Object.values(definitions).filter(
    (definition) => definition.type === "positional",
  ).length;
  if (parsed.positionals.length > allowed)
    usage(
      "Unexpected positional argument. Put the complete command path first and use named options for input.",
    );
  for (const [name, value] of Object.entries(parsed.values)) {
    const definition = definitions[name];
    if (definition?.type === "enum" && !definition.options?.includes(String(value)))
      usage(`Invalid value for --${name}.`);
  }
  return parsed.values;
}

export function integer(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value))
    usage(`--${name} requires a decimal integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    usage(`--${name} must be between ${min} and ${max}.`);
  return number;
}

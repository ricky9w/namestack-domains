import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { loadSettings, resolveRegistrar } from "../auth/resolve.js";
import { AppError } from "../core/errors.js";
import type { Presentation } from "./output.js";

export interface Context {
  signal: AbortSignal;
  view: Presentation;
}
export type Values = Record<string, unknown>;
export function stringOption(values: Values, key: string): string | undefined {
  return typeof values[key] === "string" ? (values[key] as string) : undefined;
}
export async function loadEnvFile(path: string) {
  try {
    const contents = await readFile(path, "utf8");
    if (Buffer.byteLength(contents) > 65536) throw new Error("oversize");
    for (const [key, value] of Object.entries(parseEnv(contents)))
      if (process.env[key] === undefined) process.env[key] = value;
  } catch {
    throw new AppError("CONFIG_INVALID", "Could not load the requested env file.", 2);
  }
}
export function configuration(values: Values) {
  return loadSettings(stringOption(values, "account-id"));
}
export function registrar(values: Values, signal: AbortSignal) {
  return resolveRegistrar(stringOption(values, "account-id"), signal);
}

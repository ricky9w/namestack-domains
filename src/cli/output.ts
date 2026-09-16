import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import { AppError } from "../core/errors.js";
import type { Envelope } from "../core/schema.js";

export interface Presentation {
  json: boolean;
  input: boolean;
  color: boolean;
  quiet: boolean;
}
export function isCI(env = process.env) {
  return Boolean(env.CI && env.CI !== "false" && env.CI !== "0");
}
export function presentation(values: Record<string, unknown>): Presentation {
  return {
    json:
      values.format === "json" || (values.format !== "human" && (!process.stdout.isTTY || isCI())),
    input: values.input !== false,
    color: values.color !== false && !process.env.NO_COLOR && process.env.TERM !== "dumb",
    quiet: values.quiet === true,
  };
}
export function sanitize(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove control characters from untrusted terminal text.
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function requireInteractive(view: Presentation) {
  if (
    view.json ||
    !view.input ||
    isCI() ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY ||
    process.env.TERM === "dumb"
  ) {
    throw new AppError(
      "INTERACTION_REQUIRED",
      "Saving credentials requires an interactive terminal.",
      2,
      false,
      "Run auth login in a terminal, then use --format=json --no-input for queries.",
    );
  }
}
let holding = 0;
/**
 * Report whether a Clack spinner currently holds raw stdin.
 *
 * Clack blocks stdin while a spinner runs and calls process.exit(0) on Ctrl-C,
 * so the terminal never raises SIGINT and the entrypoint has to restore the
 * documented cancellation status itself.
 */
export function progressHoldsInput() {
  return holding > 0;
}
export function beginProgress() {
  holding++;
}
export function endProgress() {
  holding = Math.max(0, holding - 1);
}
export async function withProgress<T>(
  view: Presentation,
  signal: AbortSignal,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    view.json ||
    !view.input ||
    view.quiet ||
    !process.stderr.isTTY ||
    isCI() ||
    process.env.TERM === "dumb"
  )
    return operation();
  const { spinner } = await import("@clack/prompts");
  const progress = spinner({ output: process.stderr, signal, onCancel: () => {} });
  beginProgress();
  progress.start(message);
  try {
    const result = await operation();
    progress.stop("Finished.");
    return result;
  } catch (error) {
    progress.stop("Stopped.");
    throw error;
  } finally {
    endProgress();
  }
}
type Colors = ReturnType<typeof pc.createColors>;
type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function domainLines(data: Fields, colors: Colors): string[] {
  const domains = data.domains as Record<string, unknown>[];
  if (!domains.length) return ["No domains returned."];
  return domains.map((result) => {
    const pricing = result.pricing as Fields | null;
    const error = result.error as { code?: string } | undefined;
    const line = sanitize(
      [
        result.domain,
        result.status,
        result.reason ? `(${result.reason})` : "",
        error?.code ? `[${error.code}]` : "",
        pricing
          ? `${pricing.registration} ${pricing.currency} first year, ${pricing.renewal} renewal`
          : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
    return result.status === "available" ? colors.green(line) : line;
  });
}

function extensionLines(data: Fields): string[] {
  const extensions = data.extensions as { extension: string; tld: string }[];
  if (!extensions.length) return ["No extensions returned."];
  const width = Math.max(...extensions.map((item) => item.extension.length));
  return extensions.map((item) => sanitize(`${item.extension.padEnd(width)}  under .${item.tld}`));
}

function fieldLines(data: Fields): string[] {
  const width = Math.max(...Object.keys(data).map((key) => key.length));
  return Object.entries(data).map(([key, value]) =>
    sanitize(`${key.padEnd(width)}  ${scalar(value)}`),
  );
}

/** Pick a human rendering, falling back to JSON for anything deeply nested. */
function renderData(data: Fields, colors: Colors): string[] {
  if (data.operation === "check" || data.operation === "search") return domainLines(data, colors);
  if (data.operation === "extensions") return extensionLines(data);
  if (Object.values(data).every((value) => value === null || typeof value !== "object"))
    return fieldLines(data);
  return [sanitize(JSON.stringify(data, null, 2))];
}

/** Diagnostics a human needs alongside the result, which belong on stderr. */
function notes(data: Fields): string[] {
  const lines: string[] = [];
  if (data.authoritative === false)
    lines.push("Suggestions use cached availability; confirm a candidate with check.");
  if (data.truncated === true && typeof data.cursor === "string")
    lines.push(`More results remain; continue with --cursor="${sanitize(data.cursor)}".`);
  return lines;
}

export function writeEnvelope(envelope: Envelope, view: Presentation) {
  if (view.json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  const colors = pc.createColors(view.color && Boolean(process.stdout.isTTY));
  const errorColors = pc.createColors(view.color && Boolean(process.stderr.isTTY));
  if (!envelope.ok) {
    process.stderr.write(
      `${errorColors.red(sanitize(envelope.error.code))}: ${sanitize(envelope.error.message)}\n`,
    );
    if (envelope.error.hint) process.stderr.write(`${sanitize(envelope.error.hint)}\n`);
  }
  const data = envelope.data;
  if (!isRecord(data)) {
    if (data !== undefined) process.stdout.write(`${sanitize(JSON.stringify(data, null, 2))}\n`);
    return;
  }
  for (const note of notes(data)) process.stderr.write(`${note}\n`);
  const lines = renderData(data, colors);
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}

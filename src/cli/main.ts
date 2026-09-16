#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from "node:util";
import { type ArgsDef, type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { AppError, asError, errorData, usage } from "../core/errors.js";
import type { Envelope } from "../core/schema.js";
import { commonArgs, integer, nativeOptions, validateArgs } from "./args.js";
import { presentation, progressHoldsInput, writeEnvelope } from "./output.js";

const root = defineCommand<ArgsDef>({
  meta: {
    name: "namestack-domains",
    version: pkg.version,
    description: "Query Cloudflare Registrar domain availability.",
  },
  args: commonArgs,
  subCommands: {
    check: () => import("./commands/check.js").then((module) => module.default),
    search: () => import("./commands/search.js").then((module) => module.default),
    extensions: () => import("./commands/extensions.js").then((module) => module.default),
    auth: () => import("./commands/auth.js").then((module) => module.default),
    doctor: () => import("./commands/doctor.js").then((module) => module.default),
    schema: () => import("./commands/schema.js").then((module) => module.default),
    mcp: () => import("./commands/mcp.js").then((module) => module.default),
  },
});

async function resolve<T>(value: T | (() => T | Promise<T>) | Promise<T>): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

async function main(rawArgs: string[]) {
  let view = presentation({});
  let brokenPipe = false;
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new AppError("CANCELLED", "Interrupted by SIGINT.", 130));
  const terminate = () =>
    controller.abort(new AppError("CANCELLED", "Interrupted by SIGTERM.", 143));
  const outputError = (error: NodeJS.ErrnoException) => {
    brokenPipe = true;
    process.exitCode = 1;
    controller.abort(
      new AppError(
        error.code === "EPIPE" ? "BROKEN_PIPE" : "OUTPUT_ERROR",
        "The output stream closed.",
      ),
    );
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  // Clack exits 0 from its own raw-stdin handler on Ctrl-C, bypassing SIGINT.
  process.once("exit", () => {
    if (progressHoldsInput() && !process.exitCode) process.exitCode = 130;
  });
  process.stdout.on("error", outputError);
  process.stderr.on("error", outputError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      view = presentation(
        parseArgs({
          args: rawArgs,
          options: nativeOptions(commonArgs),
          strict: false,
          allowPositionals: true,
          allowNegative: true,
        }).values,
      );
    } catch {
      /* Use automatic output until command-specific options are known. */
    }
    let command: CommandDef = root;
    const args = [...rawArgs];
    const path = ["namestack-domains"];
    while (command.subCommands && args[0] && !args[0].startsWith("-")) {
      const children = await resolve(command.subCommands);
      const name = args.shift() as string;
      if (!Object.hasOwn(children, name)) usage("Unknown command. Run namestack-domains --help.");
      command = await resolve(children[name] as CommandDef);
      path.push(name);
    }
    const definitions = (await resolve(command.args ?? {})) as ArgsDef;
    // The MCP server owns stdout for protocol messages, so its startup errors go to stderr.
    const serving = path.join(" ") === "namestack-domains mcp";
    const present = (values: Record<string, unknown>) =>
      serving ? { ...presentation(values), json: false } : presentation(values);
    // This pass selects error presentation; validation still uses strict native parsing below.
    try {
      view = present(
        parseArgs({
          args,
          options: nativeOptions(definitions),
          strict: false,
          allowPositionals: true,
          allowNegative: true,
        }).values,
      );
    } catch {
      /* Keep automatic output if malformed arguments cannot be parsed. */
    }
    const values = validateArgs(args, definitions);
    view = present(values);
    if (values.version) {
      process.stdout.write(`${pkg.version}\n`);
      return;
    }
    if (values.help || (command.subCommands && !args.length)) {
      const meta = await resolve(command.meta ?? {});
      const help = await renderUsage({
        ...command,
        meta: { ...meta, name: path.join(" "), version: pkg.version },
      });
      process.stdout.write(`${stripVTControlCharacters(help)}\n`);
      return;
    }
    if (serving) {
      // The server runs until the host closes stdin, well past this function.
      (await import("../mcp/stdio.js")).serve();
      return;
    }
    if (!command.run) usage("Specify a command before its options. Run namestack-domains --help.");
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.required && definition.default === undefined && values[name] === undefined)
        usage(`Missing required option --${name}.`);
    }
    const timeout = integer(
      values.timeout,
      "timeout",
      path.join(" ") === "namestack-domains auth login" ? 180 : 30,
      1,
      600,
    );
    timer = setTimeout(
      () =>
        controller.abort(
          new AppError("TIMEOUT", "The total operation deadline was exceeded.", 124, true),
        ),
      timeout * 1000,
    );
    if (typeof values["env-file"] === "string") {
      await (await import("./context.js")).loadEnvFile(values["env-file"]);
      view = presentation(values);
    }
    if (!view.color) {
      process.env.NO_COLOR = "1";
      delete process.env.FORCE_COLOR;
    }
    const { result } = await runCommand(command, {
      rawArgs: args,
      data: { view, signal: controller.signal },
    });
    const completed = result as { envelope: Envelope; exitCode: number };
    const { envelopeSchema } = await import("../core/schema.js");
    const envelope = envelopeSchema.parse(completed.envelope);
    if (!brokenPipe) {
      writeEnvelope(envelope, view);
      process.exitCode = completed.exitCode;
    }
  } catch (error) {
    const failure = asError(controller.signal.aborted ? controller.signal.reason : error);
    if (!brokenPipe) {
      writeEnvelope({ schemaVersion: 1, ok: false, error: errorData(failure) }, view);
      process.exitCode = failure.exitCode;
    }
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    // Keep stream error handlers until pending writes have drained.
  }
}

await main(process.argv.slice(2));

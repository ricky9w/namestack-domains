import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveRegistrar } from "../auth/resolve.js";
import { createServer } from "./server.js";

/**
 * Serve the query tools to an MCP host over stdio.
 *
 * Credentials come from the environment or the saved login, as the MCP
 * specification asks of stdio servers; this process never prompts. stdout
 * carries protocol messages only, so diagnostics go to stderr.
 */
export function serve() {
  return serveStdio(() => createServer((signal) => resolveRegistrar(undefined, signal)), {
    onerror: (error) => process.stderr.write(`${error.message}\n`),
  });
}

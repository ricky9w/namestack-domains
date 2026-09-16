#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

// stdout carries protocol messages only; diagnostics go to stderr.
serveStdio(() => createServer(), {
  onerror: (error) => process.stderr.write(`${error.message}\n`),
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DEFAULT_EXTENSIONS } from "../src/core/domains.js";
import { createServer } from "../src/mcp/server.js";
import { Cloudflare } from "../src/providers/cloudflare.js";

const account = "a".repeat(32);

async function connected(fetcher: typeof fetch) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(async () => new Cloudflare(account, "fake-token", fetcher));
  const client = new Client({ name: "namestack-domains-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const okCheck: typeof fetch = async (_url, init) => {
  const domains = JSON.parse(String(init?.body)).domains as string[];
  return Response.json({
    success: true,
    result: {
      domains: domains.map((name) => ({
        name,
        registrable: true,
        tier: "standard",
        pricing: { currency: "USD", registration_cost: "10.00", renewal_cost: "11.00" },
      })),
    },
  });
};

test("discovery exposes read-only, domain-prefixed tools with both schemas", async () => {
  const session = await connected(okCheck);
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "domains_check",
      "domains_extensions",
      "domains_search",
    ]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 0);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.outputSchema, `${tool.name} must declare an outputSchema`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  } finally {
    await session.close();
  }
});

test("a call returns the CLI envelope as structured content and matching text", async () => {
  const session = await connected(okCheck);
  try {
    const result = await session.client.callTool({
      name: "domains_check",
      arguments: { domains: ["sample-brand.com"] },
    });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as {
      ok: boolean;
      schemaVersion: number;
      data: { operation: string; domains: { domain: string; status: string }[] };
    };
    assert.equal(structured.schemaVersion, 1);
    assert.equal(structured.ok, true);
    assert.equal(structured.data.operation, "check");
    assert.equal(structured.data.domains[0]?.domain, "sample-brand.com");
    assert.equal(structured.data.domains[0]?.status, "available");
    const content = result.content as { type: string; text: string }[];
    assert.equal(content[0]?.type, "text");
    assert.deepEqual(JSON.parse(String(content[0]?.text)), structured);
  } finally {
    await session.close();
  }
});

test("an upstream failure is an isError result, and the server keeps serving", async () => {
  let deny = true;
  const session = await connected(async (url, init) => {
    if (deny) return new Response(null, { status: 403 });
    return okCheck(url, init);
  });
  try {
    const failed = await session.client.callTool({
      name: "domains_check",
      arguments: { domains: ["sample-brand.com"] },
    });
    assert.equal(failed.isError, true);
    const envelope = failed.structuredContent as { ok: boolean; error: { code: string } };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "FORBIDDEN");

    deny = false;
    const recovered = await session.client.callTool({
      name: "domains_check",
      arguments: { domains: ["sample-brand.com"] },
    });
    assert.notEqual(recovered.isError, true);
  } finally {
    await session.close();
  }
});

test("input validation fails the call before any upstream request", async () => {
  let calls = 0;
  const session = await connected(async (url, init) => {
    calls++;
    return okCheck(url, init);
  });
  try {
    const result = await session.client.callTool({
      name: "domains_search",
      arguments: { query: "x", limit: 999 },
    });
    assert.equal(result.isError, true);
    assert.match(String((result.content as { text: string }[])[0]?.text), /validation/i);
    assert.equal(calls, 0);
  } finally {
    await session.close();
  }
});

test("a name is checked across the shared default extensions, or the ones given", async () => {
  const requested: string[][] = [];
  const session = await connected(async (url, init) => {
    requested.push(JSON.parse(String(init?.body)).domains);
    return okCheck(url, init);
  });
  try {
    const defaults = await session.client.callTool({
      name: "domains_check",
      arguments: { name: "Brand" },
    });
    assert.notEqual(defaults.isError, true);
    const { data } = defaults.structuredContent as { data: { domains: { domain: string }[] } };
    assert.deepEqual(
      data.domains.map((result) => result.domain),
      DEFAULT_EXTENSIONS.map((extension) => `brand.${extension}`),
    );

    const chosen = await session.client.callTool({
      name: "domains_check",
      arguments: { name: "brand", extensions: [".dev", "co.uk"] },
    });
    assert.notEqual(chosen.isError, true);
    assert.deepEqual(requested.at(-1), ["brand.dev", "brand.co.uk"]);
  } finally {
    await session.close();
  }
});

test("a check takes exactly one of domains or name, rejected before any upstream request", async () => {
  let calls = 0;
  const session = await connected(async (url, init) => {
    calls++;
    return okCheck(url, init);
  });
  try {
    for (const args of [
      {},
      { domains: ["brand.com"], name: "brand" },
      { domains: ["brand.com"], extensions: ["com"] },
      { name: "brand.com" },
    ]) {
      const result = await session.client.callTool({ name: "domains_check", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      const envelope = result.structuredContent as { error: { code: string } };
      assert.equal(envelope.error.code, "INVALID_USAGE", JSON.stringify(args));
    }
    assert.equal(calls, 0);
  } finally {
    await session.close();
  }
});

test("namestack-domains mcp serves the tools over stdio", async () => {
  const config = await mkdtemp(join(tmpdir(), "namestack-mcp-stdio-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("CLOUDFLARE_") && !key.startsWith("NAMESTACK_"))
      env[key] = value;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--import",
      fileURLToPath(new URL("fixtures/mock-fetch.mjs", import.meta.url)),
      "src/cli/main.ts",
      "mcp",
    ],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...env,
      CLOUDFLARE_API_TOKEN: "fake-token",
      CLOUDFLARE_ACCOUNT_ID: account,
      NAMESTACK_DOMAINS_CONFIG_DIR: config,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "namestack-domains-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);
    const result = await client.callTool({ name: "domains_check", arguments: { name: "brand" } });
    assert.notEqual(result.isError, true);
    const { data } = result.structuredContent as { data: { count: number } };
    assert.equal(data.count, DEFAULT_EXTENSIONS.length);
  } finally {
    await client.close();
    await rm(config, { recursive: true, force: true });
  }
});

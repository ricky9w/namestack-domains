import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp/server.js";

const account = "a".repeat(32);

async function connected(fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "namestack-mcp-test-"));
  const previous = {
    fetch: globalThis.fetch,
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    dir: process.env.NAMESTACK_DOMAINS_CONFIG_DIR,
  };
  globalThis.fetch = fetcher;
  process.env.CLOUDFLARE_API_TOKEN = "fake-token";
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
  process.env.NAMESTACK_DOMAINS_CONFIG_DIR = directory;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "namestack-domains-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
      globalThis.fetch = previous.fetch;
      for (const [key, value] of [
        ["CLOUDFLARE_API_TOKEN", previous.token],
        ["CLOUDFLARE_ACCOUNT_ID", previous.account],
        ["NAMESTACK_DOMAINS_CONFIG_DIR", previous.dir],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
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

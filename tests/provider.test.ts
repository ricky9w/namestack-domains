import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkDomains,
  expandName,
  listExtensions,
  normalizeDomain,
  searchDomains,
} from "../src/core/domains.js";
import { AppError } from "../src/core/errors.js";
import { Cloudflare } from "../src/providers/cloudflare.js";
import { readJson, requestJson, retryAfter } from "../src/providers/http.js";

const account = "a".repeat(32);
const signal = () => AbortSignal.timeout(5000);
const fixture = JSON.parse(
  await readFile(new URL("fixtures/cloudflare.json", import.meta.url), "utf8"),
);

test("normalizes IDNs and names, rejecting URL and label injection", () => {
  assert.equal(normalizeDomain("BÜCHER.com."), "xn--bcher-kva.com");
  assert.deepEqual(expandName("brand", [".com", "co.uk"]), ["brand.com", "brand.co.uk"]);
  for (const input of [
    "https://brand.com",
    "brand.com/path",
    "brand@evil.com",
    "-brand.com",
    "x..com",
    "127.0.0.1",
    "brand.com?x=1",
    "x%2ey.com",
  ])
    assert.throws(() => normalizeDomain(input), AppError);
  assert.throws(() => expandName("one.two", ["com"]), AppError);
});

test("calls only the official read-only check and preserves unavailable reasons and prices", async () => {
  const provider = new Cloudflare(account, "fake-token", async (url, init) => {
    assert.equal(
      String(url),
      `https://api.cloudflare.com/client/v4/accounts/${account}/registrar/domain-check`,
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fake-token");
    assert.deepEqual(JSON.parse(String(init?.body)), { domains: ["sample-brand.com"] });
    return Response.json(fixture);
  });
  const results = await provider.check(["sample-brand.com"], signal());
  assert.deepEqual(
    results.map((item) => item.status),
    ["available", "unavailable", "premium", "unsupported", "restricted", "unknown"],
  );
  assert.equal(results[0]?.pricing?.renewal, "11.00");
  assert.equal(results[1]?.reason, "domain_unavailable");
  assert.equal(results[5]?.registrable, false);
  assert.equal("future_field" in (results[0] ?? {}), false);
  await assert.rejects(provider.request("registrations", signal(), {}), {
    code: "INVALID_OPERATION",
  });
});

test("splits checks at 20, deduplicates inputs and preserves partial failures", async () => {
  const batchSizes: number[] = [];
  const provider = new Cloudflare(account, "fake-token", async (_url, init) => {
    const domains = JSON.parse(String(init?.body)).domains as string[];
    batchSizes.push(domains.length);
    if (domains[0] === "brand20.com") return new Response(null, { status: 403 });
    return Response.json({
      success: true,
      result: {
        domains: domains.map((name) => ({
          name,
          registrable: false,
          reason: "domain_unavailable",
        })),
      },
    });
  });
  const domains = Array.from({ length: 42 }, (_, i) => `brand${i}.com`);
  const result = await checkDomains({ domains: [...domains, "BRAND0.com"] }, provider, signal());
  assert.deepEqual(batchSizes, [20, 20]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  if (result.envelope.ok) assert.fail();
  assert.equal(result.envelope.error.code, "PARTIAL_FAILURE");
  const data = result.envelope.data as {
    domains: { registrable: boolean | null; error?: unknown }[];
  };
  assert.equal(data.domains.length, 42);
  assert.equal(data.domains[0]?.registrable, false);
  assert.equal(data.domains[20]?.registrable, null);
  assert.ok(data.domains[41]?.error);
});

test("omitted domains become unknown, not unavailable or silently missing", async () => {
  const provider = new Cloudflare(account, "fake-token", async () =>
    Response.json({ success: true, result: { domains: [] } }),
  );
  const result = await checkDomains({ domains: ["brand.com"] }, provider, signal());
  assert.equal(result.envelope.ok, false);
  if (result.envelope.ok) assert.fail();
  assert.equal(result.envelope.error.code, "INCOMPLETE_RESPONSE");
  assert.equal(
    (result.envelope.data as { domains: { registrable: unknown }[] }).domains[0]?.registrable,
    null,
  );
});

test("search preserves literal option-like query and labels cached results", async () => {
  const provider = new Cloudflare(account, "fake-token", async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get("q"), "--help");
    assert.deepEqual(parsed.searchParams.getAll("extensions"), ["com", "dev"]);
    return Response.json({ success: true, result: { domains: [] } });
  });
  const result = await searchDomains(
    { query: "--help", limit: 3, extensions: ["com", "dev"] },
    provider,
    signal(),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.ok, true);
  if (!result.envelope.ok) assert.fail();
  const data = result.envelope.data as { authoritative: boolean; operation: string };
  assert.equal(data.authoritative, false);
  assert.equal(data.operation, "search");
  await assert.rejects(searchDomains({ query: "x", limit: 3, extra: true }, provider, signal()), {
    code: "INVALID_USAGE",
  });
});

test("extension cursors remain opaque and a final page is not mistaken for more results", async () => {
  const page = (cursor: string) =>
    new Cloudflare(account, "fake-token", async (url) => {
      assert.equal(new URL(String(url)).searchParams.get("cursor"), "opaque+/=");
      return Response.json({
        success: true,
        result: [{ metadata: { name: "co.uk", tld: "uk" } }],
        result_info: { cursor },
      });
    });
  const more = await listExtensions({ limit: 50, cursor: "opaque+/=" }, page("next+/="), signal());
  if (!more.envelope.ok) assert.fail();
  assert.deepEqual(more.envelope.data, {
    operation: "extensions",
    source: "cloudflare",
    checkedAt: (more.envelope.data as { checkedAt: string }).checkedAt,
    count: 1,
    cursor: "next+/=",
    truncated: true,
    extensions: [{ extension: "co.uk", tld: "uk" }],
  });
  const last = await listExtensions({ limit: 50, cursor: "opaque+/=" }, page(""), signal());
  if (!last.envelope.ok) assert.fail();
  const final = last.envelope.data as { cursor: string | null; truncated: boolean };
  assert.equal(final.cursor, null);
  assert.equal(final.truncated, false);
  await assert.rejects(listExtensions({ limit: 0 }, page(""), signal()), {
    code: "INVALID_USAGE",
  });
  const missing = new Cloudflare(account, "fake-token", async () =>
    Response.json({ success: true, result: [{ metadata: { name: "co.uk", tld: "uk" } }] }),
  );
  await assert.rejects(listExtensions({ limit: 50 }, missing, signal()), {
    code: "INVALID_RESPONSE",
  });
});

test("retries transient status safely and refuses long Retry-After waits", async () => {
  let calls = 0;
  await requestJson(new URL("https://api.cloudflare.com/test"), {}, signal(), async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 503, headers: { "Retry-After": "0" } })
      : Response.json({ ok: true });
  });
  assert.equal(calls, 2);
  await assert.rejects(
    requestJson(
      new URL("https://api.cloudflare.com/test"),
      {},
      signal(),
      async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    ),
    { code: "RATE_LIMITED", retryAfterSeconds: 120 },
  );
  assert.equal(
    retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT")),
    2,
  );
});

test("does not follow credential-bearing redirects or accept oversized/malformed responses", async () => {
  let calls = 0;
  await assert.rejects(
    requestJson(new URL("https://api.cloudflare.com/test"), {}, signal(), async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: "https://other.invalid" } });
    }),
    { code: "UNEXPECTED_REDIRECT" },
  );
  assert.equal(calls, 1);
  await assert.rejects(readJson(new Response("x".repeat(100)), 10), { code: "RESPONSE_TOO_LARGE" });
  await assert.rejects(readJson(new Response("not JSON")), { code: "INVALID_RESPONSE" });
});

test("cancellation retains completed results and propagates the signal exit code", async () => {
  const controller = new AbortController();
  const provider = new Cloudflare(account, "fake-token", async (_url, init) => {
    const domains = JSON.parse(String(init?.body)).domains as string[];
    controller.abort(new AppError("CANCELLED", "Interrupted.", 143));
    return Response.json({
      success: true,
      result: { domains: domains.map((name) => ({ name, registrable: true })) },
    });
  });
  const result = await checkDomains(
    { domains: Array.from({ length: 21 }, (_, i) => `x${i}.com`) },
    provider,
    controller.signal,
  );
  assert.equal(result.exitCode, 143);
});

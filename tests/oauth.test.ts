import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialStore, configDirectory, type OAuthCredentials } from "../src/auth/store.js";
import { AppError } from "../src/core/errors.js";
import {
  authorization,
  exchangeCode,
  listenCallback,
  receiveCode,
  validateOAuth,
} from "../src/providers/oauth.js";

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const config = {
  clientId: "test-client",
  redirectUri: "http://127.0.0.1:8977/callback",
  scopes: ["test-scope", "offline_access"],
};

test("PKCE uses S256 and a fresh state/verifier without a client secret", async () => {
  const first = authorization(config);
  const second = authorization(config);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(
    first.url.searchParams.get("code_challenge"),
    createHash("sha256").update(first.verifier).digest("base64url"),
  );
  assert.equal(first.url.searchParams.get("code_challenge_method"), "S256");
  const tokens = await exchangeCode(
    config,
    "test-code",
    first.verifier,
    AbortSignal.timeout(1000),
    async (url, init) => {
      assert.equal(String(url), "https://dash.cloudflare.com/oauth2/token");
      assert.equal(init?.redirect, "manual");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("code_verifier"), first.verifier);
      assert.equal(body.get("client_secret"), null);
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "test-scope offline_access",
      });
    },
  );
  assert.equal(tokens.refreshToken, "test-refresh");
  assert.ok(tokens.expiresAt > Date.now());
});

test("rejects non-loopback callbacks and missing scopes", () => {
  for (const redirectUri of [
    "http://evil.invalid:8977/callback",
    "http://0.0.0.0:8977/callback",
    "http://127.0.0.1:8977/callback?x=1",
    "http://127.0.0.1/callback",
  ])
    assert.throws(() => validateOAuth({ ...config, redirectUri }), AppError);
  assert.throws(() => validateOAuth({ ...config, scopes: [] }), AppError);
});

test("loopback callback rejects incorrect state/host and accepts only a matching code", async () => {
  const controller = new AbortController();
  const { server, redirect } = await listenCallback(
    { host: "127.0.0.1", path: "/callback", port: 0 },
    controller.signal,
  );
  const code = await receiveCode(
    server,
    redirect,
    "expected-state",
    controller.signal,
    async () => {
      assert.equal((await fetch(`${redirect}?code=wrong&state=bad`)).status, 400);
      const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          `${redirect}?code=wrong&state=expected-state`,
          { headers: { Host: "other.invalid" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(wrongHostStatus, 400);
      const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port: redirect.port, path: "//[" },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(malformedStatus, 400);
      assert.equal((await fetch(`${redirect}?code=a&code=b&state=expected-state`)).status, 400);
      const response = await fetch(`${redirect}?code=valid-code&state=expected-state`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.status, 200);
    },
  );
  assert.equal(code, "valid-code");
  await assert.rejects(fetch(redirect));
});

test("denial and cancellation close the callback server", async () => {
  for (const deny of [true, false]) {
    const controller = new AbortController();
    const { server, redirect } = await listenCallback(
      { host: "127.0.0.1", path: "/callback", port: 0 },
      controller.signal,
    );
    await assert.rejects(
      receiveCode(server, redirect, "state", controller.signal, async () => {
        if (deny) await fetch(`${redirect}?error=invalid_scope&state=state`);
        else controller.abort(new AppError("CANCELLED", "Cancelled.", 130));
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, deny ? "AUTH_DENIED" : "CANCELLED");
        if (deny) {
          assert.match(error.message, /invalid_scope/);
          assert.match(String(error.hint), /scope list/);
        }
        return true;
      },
    );
    await assert.rejects(fetch(redirect));
  }
});

test("OAuth exchange failures are not retried and upstream secrets are not echoed", async () => {
  let calls = 0;
  await assert.rejects(
    exchangeCode(config, "code", "verifier", AbortSignal.timeout(1000), async () => {
      calls++;
      return Response.json({ error: "secret-do-not-echo" }, { status: 503 });
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message.includes("secret-do-not-echo"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("callback binding takes a fresh ephemeral port and honors a pinned one", async () => {
  const signal = AbortSignal.timeout(2000);
  const first = await listenCallback({ host: "127.0.0.1", path: "/callback", port: 0 }, signal);
  const second = await listenCallback({ host: "127.0.0.1", path: "/callback", port: 0 }, signal);
  try {
    for (const { redirect } of [first, second]) {
      assert.equal(redirect.hostname, "127.0.0.1");
      assert.equal(redirect.pathname, "/callback");
      assert.ok(Number(redirect.port) >= 1024);
    }
    assert.notEqual(first.redirect.port, second.redirect.port);
  } finally {
    for (const { server } of [first, second])
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const pinned = await unusedPort();
  const fixed = await listenCallback(
    { host: "127.0.0.1", path: "/callback", port: pinned },
    signal,
  );
  assert.equal(fixed.redirect.port, String(pinned));
  await new Promise<void>((resolve) => fixed.server.close(() => resolve()));
  const taken = createServer();
  const busy = await unusedPort();
  await new Promise<void>((resolve) => taken.listen(busy, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      listenCallback({ host: "127.0.0.1", path: "/callback", port: busy }, signal),
      { code: "CALLBACK_UNAVAILABLE" },
    );
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  }
});

test("an optional scope may be declined while a required scope may not", async () => {
  const requested = {
    ...config,
    scopes: ["test-scope", "optional-scope", "offline_access"],
    required: ["test-scope", "offline_access"],
  };
  const granted = await exchangeCode(
    requested,
    "code",
    "verifier",
    AbortSignal.timeout(1000),
    async () =>
      Response.json({
        access_token: "access",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "test-scope offline_access",
      }),
  );
  assert.deepEqual(granted.scopes, ["test-scope", "offline_access"]);
  await assert.rejects(
    exchangeCode(requested, "code", "verifier", AbortSignal.timeout(1000), async () =>
      Response.json({
        access_token: "access",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "optional-scope offline_access",
      }),
    ),
    { code: "AUTH_SCOPE_MISSING" },
  );
});

test("credentials are private, atomic, and concurrent refreshes rotate once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "namestack-auth-test-"));
  try {
    const store = new CredentialStore(directory);
    const saved: OAuthCredentials = {
      version: 1,
      method: "oauth",
      accountId: "a".repeat(32),
      ...config,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1,
      savedAt: new Date().toISOString(),
    };
    await store.write(saved);
    if (process.platform !== "win32") {
      assert.equal((await stat(store.path)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "old-refresh");
      await sleep(30);
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "bearer",
      });
    };
    const [first, second] = await Promise.all([
      store.access(AbortSignal.timeout(2000), fetcher),
      store.access(AbortSignal.timeout(2000), fetcher),
    ]);
    assert.equal(calls, 1);
    assert.equal(first?.token, "new-access");
    assert.equal(second?.token, "new-access");
    assert.equal(first?.method, "oauth");
    assert.deepEqual(await readdir(directory), ["credentials.json"]);
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).refreshToken, "new-refresh");
    await writeFile(store.path, "broken");
    await assert.rejects(store.read(), { code: "CREDENTIALS_INVALID" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an API token credential is returned without any network request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "namestack-token-test-"));
  try {
    const store = new CredentialStore(directory);
    await store.write({
      version: 1,
      method: "api-token",
      accountId: "b".repeat(32),
      token: "saved-api-token",
      tokenId: "token-id",
      savedAt: new Date().toISOString(),
    });
    const access = await store.access(AbortSignal.timeout(1000), () => {
      throw new Error("an API token must not trigger a token request");
    });
    assert.deepEqual(access, {
      method: "api-token",
      accountId: "b".repeat(32),
      token: "saved-api-token",
    });
    await store.remove();
    await assert.rejects(store.access(AbortSignal.timeout(1000)), { code: "AUTH_REQUIRED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the config directory is namespaced per tool and honors the documented overrides", () => {
  assert.equal(
    configDirectory({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv),
    "/xdg/namestack/domains",
  );
  assert.equal(
    configDirectory({ NAMESTACK_CONFIG_DIR: "/opt/ns" } as NodeJS.ProcessEnv),
    "/opt/ns/domains",
  );
  assert.equal(
    configDirectory({ NAMESTACK_DOMAINS_CONFIG_DIR: "/explicit" } as NodeJS.ProcessEnv),
    "/explicit",
  );
  assert.throws(
    () => configDirectory({ NAMESTACK_DOMAINS_CONFIG_DIR: "relative" } as NodeJS.ProcessEnv),
    { code: "CONFIG_INVALID" },
  );
});

test("failed credential operations release the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "namestack-lock-test-"));
  try {
    const store = new CredentialStore(directory);
    await assert.rejects(
      store.locked(AbortSignal.timeout(1000), async () => {
        throw new Error("test");
      }),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

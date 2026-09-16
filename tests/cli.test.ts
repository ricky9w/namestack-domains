import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXTENSIONS } from "../src/core/domains.js";

const directory = fileURLToPath(new URL("..", import.meta.url));
const mock = fileURLToPath(new URL("fixtures/mock-fetch.mjs", import.meta.url));

async function cli(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: NodeJS.Signals;
    mock?: boolean;
    input?: string;
  } = {},
) {
  const config = await mkdtemp(join(tmpdir(), "namestack-cli-test-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NAMESTACK_DOMAINS_CONFIG_DIR: config,
    CLOUDFLARE_API_TOKEN: "fake-token",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CI: "true",
    ...options.env,
  };
  if (
    options.env &&
    Object.hasOwn(options.env, "CLOUDFLARE_API_TOKEN") &&
    options.env.CLOUDFLARE_API_TOKEN === undefined
  )
    delete env.CLOUDFLARE_API_TOKEN;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        ...(options.mock === false ? [] : ["--import", mock]),
        "src/cli/main.ts",
        ...args,
      ],
      {
        cwd: directory,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // An empty stdin reads like a closed one, which is what non-interactive callers provide.
    child.stdin.end(options.input ?? "");
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI test exceeded deadline"));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.signal && stderr.includes("TEST_REQUEST_STARTED")) child.kill(options.signal);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      await rm(config, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("check emits exactly one JSON envelope and keeps non-TTY stderr empty", async () => {
  const result = await cli(["check", "--name=brand", "--no-input"], {
    env: { FORCE_COLOR: "3", NO_COLOR: undefined },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.data.domains.map((domain: { domain: string }) => domain.domain),
    DEFAULT_EXTENSIONS.map((extension) => `brand.${extension}`),
  );
  assert.equal(parsed.data.authoritative, true);
  assert.equal(result.stdout.includes("\x1b"), false);
});

test("unavailable domains are successful checks, while provider failure is nonzero", async () => {
  const unavailable = await cli(["check", "--domains=brand.com"], {
    env: { NAMESTACK_TEST_RESPONSE: "unavailable" },
  });
  assert.equal(unavailable.code, 0);
  assert.equal(JSON.parse(unavailable.stdout).data.domains[0].status, "unavailable");
  const failure = await cli(["check", "--domains=brand.com"], {
    env: { NAMESTACK_TEST_RESPONSE: "forbidden" },
  });
  assert.equal(failure.code, 1);
  assert.equal(JSON.parse(failure.stdout).error.code, "FORBIDDEN");
  assert.equal(failure.stderr, "");
});

test("invalid usage rejects typos, repeats, option conflicts and nondecimal counts", async () => {
  const cases = [
    ["check", "--name=brand", "--limti=2"],
    ["check", "--name"],
    ["check", "--name=brand", "--name=other"],
    ["check", "--name=brand", "--input", "--no-input"],
    ["check", "--name=brand", "--domains=x.com"],
    ["search", "--query=x", "--limit=0x10"],
    ["search", "--query=x", "--limit=1e1"],
    ["search", "--query=x", "--limit=2junk"],
    ["check", "--name=brand", "--timeout=0"],
    ["--format=json", "check", "--name=brand"],
    ["search", "--query="],
    ["check", "--name=brand", "--", "--help"],
  ];
  for (const args of cases) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_USAGE", args.join(" "));
    assert.equal(result.stderr, "");
  }
});

test("help/version/schema work offline and help-looking query values stay data", async () => {
  for (const args of [
    ["--help"],
    ["search", "--help"],
    ["auth", "login", "--help"],
    ["--version"],
    ["schema"],
  ]) {
    const result = await cli(args, { mock: false, env: { CLOUDFLARE_API_TOKEN: undefined } });
    assert.equal(result.code, 0, args.join(" "));
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("\x1b"), false);
  }
  const literal = await cli(["search", "--query=--help"]);
  assert.equal(literal.code, 0);
  assert.equal(JSON.parse(literal.stdout).data.operation, "search");
});

test("machine login fails immediately, including explicit human output without a TTY", async () => {
  for (const args of [
    ["auth", "login"],
    ["auth", "login", "--format=human"],
    ["auth", "login", "--no-input"],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2);
    assert.equal((result.stdout + result.stderr).includes("INTERACTION_REQUIRED"), true);
    assert.equal((result.stdout + result.stderr).includes("Opening Cloudflare"), false);
  }
});

test("missing credentials fail without starting any authentication", async () => {
  const result = await cli(["check", "--domains=brand.com"], {
    env: { CLOUDFLARE_API_TOKEN: undefined },
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "AUTH_REQUIRED");
  assert.equal(result.stderr, "");
});

test("total deadlines and process signals abort network work", async () => {
  const timeout = await cli(["check", "--domains=brand.com", "--timeout=1"], {
    env: { NAMESTACK_TEST_RESPONSE: "hang" },
  });
  assert.equal(timeout.code, 124);
  assert.equal(JSON.parse(timeout.stdout).error.code, "TIMEOUT");
  if (process.platform !== "win32") {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const result = await cli(["check", "--domains=brand.com"], {
        signal,
        env: { NAMESTACK_TEST_RESPONSE: "hang" },
      });
      assert.equal(result.code, code);
      assert.equal(JSON.parse(result.stdout).error.code, "CANCELLED");
    }
  }
});

test("explicit env files do not override existing environment values", async () => {
  const folder = await mkdtemp(join(tmpdir(), "namestack-env-test-"));
  try {
    const path = join(folder, "test.env");
    await writeFile(path, "CLOUDFLARE_ACCOUNT_ID=invalid\n");
    const result = await cli(["check", "--domains=brand.com", `--env-file=${path}`]);
    assert.equal(result.code, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("an environment token takes its account from the saved login when none is set", async () => {
  const config = await mkdtemp(join(tmpdir(), "namestack-account-test-"));
  try {
    const saved = "b".repeat(32);
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "credentials.json"),
      JSON.stringify({
        version: 1,
        method: "api-token",
        accountId: saved,
        token: "saved-token",
        savedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const env = { CLOUDFLARE_ACCOUNT_ID: undefined, NAMESTACK_TEST_ACCOUNT: saved };
    const fallback = await cli(["check", "--domains=brand.com"], {
      env: { ...env, NAMESTACK_DOMAINS_CONFIG_DIR: config },
    });
    assert.equal(fallback.code, 0, fallback.stdout);

    const missing = await cli(["check", "--domains=brand.com"], { env });
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stdout).error.code, "CONFIG_REQUIRED");
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("mcp keeps stdout for protocol messages and exits when the host closes stdin", async () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "namestack-domains-test", version: "0.0.0" },
    },
  };
  const served = await cli(["mcp"], { input: `${JSON.stringify(initialize)}\n` });
  assert.equal(served.code, 0);
  assert.equal(served.stderr, "");
  const lines = served.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "").result.serverInfo.name, "namestack-domains");

  const invalid = await cli(["mcp", "--format=json"]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /INVALID_USAGE/);
});

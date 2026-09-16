import { spawn } from "node:child_process";
import {
  builtInClientId,
  OPTIONAL_SCOPES,
  REGISTERED_REDIRECT,
  REQUIRED_SCOPES,
} from "../auth/client.js";
import {
  type ApiTokenCredentials,
  CredentialStore,
  configDirectory,
  type OAuthCredentials,
  readConfig,
} from "../auth/store.js";
import { csv } from "../core/domains.js";
import { AppError } from "../core/errors.js";
import { success } from "../core/schema.js";
import { type Account, listAccounts, verifyApiToken } from "../providers/cloudflare.js";
import {
  authorization,
  exchangeCode,
  listenCallback,
  receiveCode,
  revokeToken,
  validateOAuth,
} from "../providers/oauth.js";
import { type Context, configuration, stringOption, type Values } from "./context.js";
import { beginProgress, endProgress, requireInteractive, withProgress } from "./output.js";

type Clack = typeof import("@clack/prompts");
type Settings = Awaited<ReturnType<typeof configuration>>;
type PromptOpts = { output: NodeJS.WriteStream; signal: AbortSignal };

const ACCOUNT_ID = /^[0-9a-fA-F]{32}$/;
const API_TOKEN = /^[A-Za-z0-9._~-]{20,256}$/;
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** Prompts belong on stderr; stdout carries only the result envelope. */
const stream = { output: process.stderr } as const;

function decided<T>(clack: Clack, value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new AppError("CANCELLED", "Authentication was cancelled.", 130);
  return value as Exclude<T, symbol>;
}

export async function openBrowser(url: URL) {
  if (url.origin !== "https://dash.cloudflare.com" || url.pathname !== "/oauth2/auth")
    throw new AppError("INVALID_AUTH_URL", "Refusing an unexpected authorization URL.");
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url.href]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url.href]]
        : ["xdg-open", [url.href]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command as string, args as string[], {
      stdio: "ignore",
      detached: true,
      shell: false,
    });
    child.once("error", () =>
      reject(new AppError("BROWSER_UNAVAILABLE", "Could not open the default browser.")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function login(values: Values, context: Context) {
  requireInteractive(context.view);
  const settings = await configuration(values);
  const clack = await import("@clack/prompts");
  const opts = { ...stream, signal: context.signal };

  clack.intro("namestack-domains auth login", stream);
  if (process.env.CLOUDFLARE_API_TOKEN?.trim())
    clack.log.warn(
      "CLOUDFLARE_API_TOKEN is set. Queries keep using it in preference to whatever you save here.",
      stream,
    );

  const clientId =
    stringOption(values, "client-id") ?? settings.config.clientId ?? builtInClientId();
  const method =
    stringOption(values, "method") ??
    decided(
      clack,
      await clack.select<"api-token" | "oauth">({
        message: "How do you want to authenticate?",
        options: [
          {
            value: "oauth",
            label: "OAuth",
            hint: clientId
              ? "authorize in your browser, nothing to set up first"
              : "no OAuth client is configured",
            disabled: !clientId,
          },
          {
            value: "api-token",
            label: "API token",
            hint: "create a read-only token in the Cloudflare dashboard",
          },
        ],
        initialValue: clientId ? "oauth" : "api-token",
        ...opts,
      }),
    );

  const credentials =
    method === "oauth"
      ? await oauthLogin(clack, opts, values, settings, clientId, context)
      : await apiTokenLogin(clack, opts, settings, context);

  await settings.store.locked(context.signal, () => settings.store.write(credentials));
  clack.outro(`Saved ${method} credentials to ${settings.store.path}`, stream);
  return {
    envelope: success({
      authenticated: true,
      method: credentials.method,
      accountId: credentials.accountId,
      expiresAt:
        credentials.method === "oauth" ? new Date(credentials.expiresAt).toISOString() : null,
      refreshable: credentials.method === "oauth" ? Boolean(credentials.refreshToken) : null,
      registrarAccessVerified: false,
      next: "Run namestack-domains doctor --online to verify Registrar query access.",
    }),
    exitCode: 0,
  };
}

async function apiTokenLogin(
  clack: Clack,
  opts: PromptOpts,
  settings: Settings,
  context: Context,
): Promise<ApiTokenCredentials> {
  clack.note(
    [
      `1. Open ${TOKENS_URL}`,
      "2. Choose Create Token, then Create Custom Token",
      "3. Permissions: Account > Registrar Domains > Read",
      "4. Account Resources: include the account you want to query",
    ].join("\n"),
    "Create a Cloudflare API token",
    stream,
  );
  const token = decided(
    clack,
    await clack.password({
      message: "Paste the API token",
      mask: "•",
      validate: (value) =>
        API_TOKEN.test((value ?? "").trim())
          ? undefined
          : "Enter the API token exactly as Cloudflare displayed it.",
      ...opts,
    }),
  ).trim();

  // A user token verifies here; an account-owned token only verifies under its account.
  let verified = await withProgress(context.view, context.signal, "Verifying the API token", () =>
    optional(context, () => verifyApiToken(token, context.signal)),
  );
  const accounts = await optional(context, () => listAccounts(token, context.signal));
  const accountId = await resolveAccount(clack, opts, accounts ?? [], settings.accountId);
  verified ??= await verifyApiToken(token, context.signal, accountId);

  return {
    version: 1,
    method: "api-token",
    accountId,
    token,
    savedAt: new Date().toISOString(),
    ...(verified ? { tokenId: verified.id } : {}),
  };
}

async function oauthLogin(
  clack: Clack,
  opts: PromptOpts,
  values: Values,
  settings: Settings,
  clientId: string,
  context: Context,
): Promise<OAuthCredentials> {
  const chosen = stringOption(values, "scopes") ?? process.env.NAMESTACK_DOMAINS_OAUTH_SCOPES;
  const scopes =
    chosen === undefined
      ? (settings.config.scopes ?? [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES])
      : csv(chosen, 20);
  const explicit =
    stringOption(values, "redirect-uri") ??
    process.env.NAMESTACK_DOMAINS_OAUTH_REDIRECT_URI ??
    settings.config.redirectUri;
  const config = {
    clientId,
    redirectUri: explicit ?? REGISTERED_REDIRECT,
    scopes,
    required: scopes.filter((scope) => !OPTIONAL_SCOPES.includes(scope)),
  };
  // Validate before binding so a bad client or redirect fails without a listener.
  const registered = validateOAuth(config);
  // Take an ephemeral port unless a redirect was pinned for an exact-matching client.
  const { server, redirect } = await listenCallback(
    {
      host: registered.hostname,
      path: registered.pathname,
      port: explicit === undefined ? 0 : Number(registered.port),
    },
    context.signal,
  );
  config.redirectUri = redirect.href;
  const request = authorization(config);

  let progress: ReturnType<Clack["spinner"]> | undefined;
  let code: string;
  try {
    code = await receiveCode(server, redirect, request.state, context.signal, async () => {
      // Print the URL before offering to open it, so a failed browser launch is
      // recoverable. It goes out unwrapped and unboxed to stay copyable in one piece.
      clack.log.step("Authorize namestack-domains at this URL:", stream);
      process.stderr.write(`\n${request.url.href}\n\n`);
      const open = decided(
        clack,
        await clack.confirm({
          message: "Open this URL in your default browser?",
          initialValue: true,
          ...opts,
        }),
      );
      if (open)
        await openBrowser(request.url).catch(() =>
          clack.log.warn("Could not open a browser. Copy the URL above instead.", stream),
        );
      progress = clack.spinner({ ...stream, signal: context.signal, onCancel: () => {} });
      beginProgress();
      progress.start("Waiting for authorization in the browser");
    });
  } catch (error) {
    if (progress) endProgress();
    progress?.stop("Authorization did not complete.");
    throw error;
  }
  if (progress) endProgress();
  progress?.stop("Authorization received.");

  const tokens = await withProgress(
    context.view,
    context.signal,
    "Exchanging the authorization code",
    () => exchangeCode(config, code, request.verifier, context.signal),
  );
  const accounts = await optional(context, () => listAccounts(tokens.accessToken, context.signal));
  const accountId = await resolveAccount(clack, opts, accounts ?? [], settings.accountId);

  return {
    version: 1,
    method: "oauth",
    accountId,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    savedAt: new Date().toISOString(),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  };
}

/**
 * Decide which account queries run against.
 *
 * A credential scoped only to Registrar cannot list accounts, so an empty list
 * is an ordinary outcome that has to be answered by asking for the id.
 */
async function resolveAccount(
  clack: Clack,
  opts: PromptOpts,
  accounts: Account[],
  preset: string | undefined,
): Promise<string> {
  if (preset !== undefined) {
    if (!ACCOUNT_ID.test(preset))
      throw new AppError(
        "CONFIG_INVALID",
        "Cloudflare account ID must contain 32 hexadecimal characters.",
        2,
      );
    return preset.toLowerCase();
  }
  const [first] = accounts;
  if (accounts.length === 1 && first) {
    clack.log.info(`Using the only account this credential can see: ${first.name}.`, stream);
    return first.id.toLowerCase();
  }
  if (accounts.length > 1)
    return decided(
      clack,
      await clack.select<string>({
        message: "Which Cloudflare account should queries use?",
        options: accounts.map((account) => ({
          value: account.id,
          label: account.name,
          hint: account.id,
        })),
        ...opts,
      }),
    ).toLowerCase();

  clack.log.warn(
    "This credential cannot list accounts, which needs the Account Settings Read permission.",
    stream,
  );
  clack.note(
    "Open https://dash.cloudflare.com/ and select the account.\nIts 32-character ID appears in the address bar and on the account home page.",
    "Find the account ID",
    stream,
  );
  return decided(
    clack,
    await clack.text({
      message: "Cloudflare account ID",
      placeholder: "32 hexadecimal characters",
      validate: (value) =>
        ACCOUNT_ID.test((value ?? "").trim()) ? undefined : "Enter 32 hexadecimal characters.",
      ...opts,
    }),
  )
    .trim()
    .toLowerCase();
}

/** Run a probe whose failure is informative but not fatal, while still honoring cancellation. */
async function optional<T>(context: Context, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (context.signal.aborted) throw error;
    return undefined;
  }
}

export async function status() {
  const directory = configDirectory();
  const config = await readConfig(directory);
  const store = new CredentialStore(directory);
  const saved = await store.read().catch(() => undefined);
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken !== undefined && !envToken.trim())
    throw new AppError("CONFIG_INVALID", "CLOUDFLARE_API_TOKEN is empty.", 2);
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ?? config.accountId ?? saved?.accountId ?? null;
  return {
    envelope: success({
      configured: envToken !== undefined || Boolean(saved),
      source: envToken !== undefined ? "environment" : saved ? "file" : null,
      method: envToken !== undefined ? "api-token" : (saved?.method ?? null),
      accountId,
      path: store.path,
      savedMethod: saved?.method ?? null,
      expiresAt: saved?.method === "oauth" ? new Date(saved.expiresAt).toISOString() : null,
      expired: saved?.method === "oauth" ? saved.expiresAt <= Date.now() : null,
      refreshable: saved?.method === "oauth" ? Boolean(saved.refreshToken) : null,
      verified: false,
    }),
    exitCode: 0,
  };
}

export async function logout(values: Values, context: Context) {
  const store = new CredentialStore(configDirectory());
  return store.locked(context.signal, async () => {
    const saved = await store.read().catch(() => undefined);
    const revoke = saved?.method === "oauth" && values.local !== true;
    if (saved?.method === "oauth" && revoke)
      await revokeToken(saved.clientId, saved.refreshToken ?? saved.accessToken, context.signal);
    await store.remove();
    return {
      envelope: success({
        removed: Boolean(saved),
        method: saved?.method ?? null,
        revoked: revoke,
        environmentTokenStillSet: process.env.CLOUDFLARE_API_TOKEN !== undefined,
        next:
          saved?.method === "api-token"
            ? `Delete the token at ${TOKENS_URL} if it is no longer needed.`
            : null,
      }),
      exitCode: 0,
    };
  });
}

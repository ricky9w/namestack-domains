import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { AppError } from "../core/errors.js";
import { type Fetch, readJson } from "./http.js";

export const OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};
export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  /** Every scope sent to the authorization endpoint. */
  scopes: string[];
  /** Subset that must come back granted; the rest may be declined on consent. */
  required?: string[];
}
export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export function validateOAuth(config: OAuthConfig) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(config.clientId))
    throw new AppError("CONFIG_INVALID", "Set a valid OAuth client ID.", 2);
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new AppError("CONFIG_INVALID", "Set an absolute loopback OAuth redirect URI.", 2);
  }
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
    !redirect.port ||
    Number(redirect.port) < 1024 ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== "/callback"
  ) {
    throw new AppError(
      "CONFIG_INVALID",
      "OAuth redirect must be http://127.0.0.1:<port>/callback, with port 1024–65535.",
      2,
    );
  }
  if (
    !config.scopes.length ||
    config.scopes.length > 20 ||
    config.scopes.some((scope) => !/^[a-zA-Z0-9._:-]{1,100}$/.test(scope))
  ) {
    throw new AppError(
      "CONFIG_INVALID",
      "Set the exact OAuth scope IDs configured on your Cloudflare client.",
      2,
    );
  }
  return redirect;
}

export function authorization(config: OAuthConfig) {
  validateOAuth(config);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(OAUTH.authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url, state, verifier };
}

export interface CallbackTarget {
  /** Loopback host, in URL form so an IPv6 literal keeps its brackets. */
  host: string;
  /** Path the authorization server matches exactly. */
  path: string;
  /** Fixed port, or 0 to take an ephemeral one from the operating system. */
  port: number;
}

/**
 * Bind the loopback callback listener.
 *
 * RFC 8252 section 7.3 has the authorization server allow any port precisely so
 * that a native client can take an ephemeral one per request, which is what a
 * zero port here asks for.
 */
export async function listenCallback(
  target: CallbackTarget,
  signal: AbortSignal,
): Promise<{ server: Server; redirect: URL }> {
  signal.throwIfAborted();
  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: 5000,
    headersTimeout: 5000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Bind exactly what the redirect names so localhost/::1 cannot resolve elsewhere.
      server.listen({ host: target.host.replace(/^\[|\]$/g, ""), port: target.port }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return { server, redirect: new URL(`http://${target.host}:${address.port}${target.path}`) };
  } catch {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new AppError(
      "CALLBACK_UNAVAILABLE",
      target.port === 0
        ? "Could not bind a loopback OAuth callback port."
        : `Loopback OAuth callback port ${target.port} is unavailable.`,
      1,
      false,
      target.port === 0
        ? "Check whether local network listeners are blocked, then run auth login again."
        : "Free the port, or drop --redirect-uri to use an ephemeral port.",
    );
  }
}

/** Wait for the authorization code on an already bound callback server. */
export async function receiveCode(
  server: Server,
  redirect: URL,
  state: string,
  signal: AbortSignal,
  onReady: () => Promise<void>,
): Promise<string> {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: unknown) => void = () => {};
  const pending = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler before onReady can fail or cancellation can arrive.
  void pending.catch(() => {});
  server.on("request", (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    if (req.method !== "GET" || req.headers.host !== redirect.host || !req.url?.startsWith("/")) {
      res.writeHead(400).end("Invalid callback.");
      return;
    }
    let callback: URL;
    try {
      callback = new URL(req.url, redirect.origin);
    } catch {
      res.writeHead(400).end("Invalid callback URL.");
      return;
    }
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
      res.writeHead(404).end("Not found.");
      return;
    }
    if (
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.get("state") !== state
    ) {
      res.writeHead(400).end("Invalid authorization state.");
      return;
    }
    const code = callback.searchParams.get("code");
    if (callback.searchParams.has("error")) {
      // Cloudflare reports a misconfigured client here too, not only a refusal.
      const raw = callback.searchParams.get("error") ?? "";
      const reason = /^[a-z_]{1,64}$/.test(raw) ? raw : "unknown_error";
      res.writeHead(400).end("Authorization was not granted. Return to the terminal.");
      rejectCode(
        new AppError(
          "AUTH_DENIED",
          `Cloudflare did not grant the authorization (${reason}).`,
          1,
          false,
          reason === "invalid_scope"
            ? "The OAuth client does not offer every requested scope. Compare its scope list in the Cloudflare dashboard."
            : undefined,
        ),
      );
      return;
    }
    if (!code || code.length > 4096 || callback.searchParams.getAll("code").length !== 1) {
      res.writeHead(400).end("Missing or invalid authorization code.");
      return;
    }
    res.end("Authorization received. Return to the terminal to finish signing in.");
    resolveCode(code);
  });
  server.on("error", () =>
    rejectCode(
      new AppError("CALLBACK_UNAVAILABLE", "The OAuth callback listener stopped unexpectedly."),
    ),
  );
  const abort = () => rejectCode(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await onReady();
    return await pending;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof AppError) throw error;
    throw new AppError("CALLBACK_UNAVAILABLE", "The OAuth callback listener failed.");
  } finally {
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function tokenRequest(
  params: URLSearchParams,
  scopes: string[],
  signal: AbortSignal,
  fetcher: Fetch,
): Promise<Tokens> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new AppError("TIMEOUT", "OAuth request timed out. Run auth login again if necessary.", 124),
      ),
    10_000,
  );
  try {
    const response = await fetcher(OAUTH.token, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.any([signal, controller.signal]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "AUTH_FAILED",
        "Cloudflare could not exchange or refresh the authorization.",
        1,
        false,
        "Check the OAuth client, redirect URI and scopes, then run auth login again.",
      );
    }
    const parsed = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().int().positive().max(31_536_000),
        token_type: z.string(),
        scope: z.string().optional(),
      })
      .safeParse(await readJson(response, 131_072));
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer")
      throw new AppError("AUTH_FAILED", "Cloudflare returned an invalid OAuth token response.");
    const granted = parsed.data.scope?.split(/\s+/).filter(Boolean) ?? scopes;
    if (
      scopes
        .filter((scope) => !["offline_access", "offline"].includes(scope))
        .some((scope) => !granted.includes(scope))
    ) {
      throw new AppError("AUTH_SCOPE_MISSING", "Cloudflare did not grant all requested scopes.");
    }
    return {
      accessToken: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      scopes: granted,
      ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof AppError) throw error;
    throw new AppError(
      "AUTH_NETWORK_ERROR",
      "OAuth request failed. It was not automatically retried.",
      1,
      false,
      "Run auth login again if the authorization has already been consumed.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function exchangeCode(
  config: OAuthConfig,
  code: string,
  verifier: string,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: verifier,
    }),
    config.required ?? config.scopes,
    signal,
    fetcher,
  );
}
export function refreshTokens(
  clientId: string,
  refreshToken: string,
  scopes: string[],
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
    scopes,
    signal,
    fetcher,
  );
}
export async function revokeToken(
  clientId: string,
  token: string,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
) {
  const response = await fetcher(OAUTH.revoke, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token }),
    signal,
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new AppError(
      "REVOKE_FAILED",
      "Cloudflare did not confirm token revocation.",
      1,
      true,
      "Retry, or use auth logout --local and revoke the application in the dashboard.",
    );
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { Fetch } from "../providers/http.js";

const accountId = z.string().regex(/^[a-fA-F0-9]{32}$/);

export const oauthCredentialsSchema = z.strictObject({
  version: z.literal(1),
  method: z.literal("oauth"),
  accountId,
  clientId: z.string().min(1),
  redirectUri: z.string(),
  scopes: z.array(z.string()),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().positive(),
  savedAt: z.string(),
});
export const apiTokenCredentialsSchema = z.strictObject({
  version: z.literal(1),
  method: z.literal("api-token"),
  accountId,
  token: z.string().min(1),
  tokenId: z.string().optional(),
  savedAt: z.string(),
});
export const credentialsSchema = z.discriminatedUnion("method", [
  oauthCredentialsSchema,
  apiTokenCredentialsSchema,
]);
export type OAuthCredentials = z.infer<typeof oauthCredentialsSchema>;
export type ApiTokenCredentials = z.infer<typeof apiTokenCredentialsSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

/** Bearer credential plus the account it queries, independent of how it was obtained. */
export interface Access {
  method: Credentials["method"];
  accountId: string;
  token: string;
}

const configSchema = z.strictObject({
  accountId: z.string().optional(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  redirectUri: z.string().optional(),
});

/**
 * Resolve the per-tool config directory.
 *
 * Namespaced as `<config>/namestack/domains` so every Namestack tool keeps its
 * credentials under one parent that the user can relocate with XDG_CONFIG_HOME
 * or NAMESTACK_CONFIG_DIR.
 */
export function configDirectory(env = process.env): string {
  const workspace =
    env.NAMESTACK_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "namestack");
  const directory = env.NAMESTACK_DOMAINS_CONFIG_DIR ?? join(workspace, "domains");
  if (!isAbsolute(directory))
    throw new AppError(
      "CONFIG_INVALID",
      "The configuration directory must be an absolute path.",
      2,
    );
  return directory;
}

export async function readConfig(directory: string) {
  try {
    const text = await readFile(join(directory, "config.json"), "utf8");
    if (Buffer.byteLength(text) > 65536) throw new Error("oversize");
    return configSchema.parse(JSON.parse(text));
  } catch (error) {
    if (isCode(error, "ENOENT")) return {};
    throw new AppError(
      "CONFIG_INVALID",
      "Could not read config.json; check its contents and permissions.",
      2,
    );
  }
}

export class CredentialStore {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "credentials.json");
  }

  async read(): Promise<Credentials | undefined> {
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.size > 131072 ||
          (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        ) {
          throw new Error("unsafe credentials");
        }
        return credentialsSchema.parse(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw new AppError(
        "CREDENTIALS_INVALID",
        "Could not read credentials.json; check its contents and private file permissions.",
        1,
        false,
        "Run auth login again to replace the saved credentials.",
      );
    }
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppError("CONFIG_INVALID", "The credential directory must be a regular directory.");
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
  }

  async write(credentials: Credentials) {
    await this.prepare();
    const value = credentialsSchema.parse(credentials);
    const temporary = join(this.directory, `.credentials-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove() {
    await rm(this.path, { force: true });
  }

  async locked<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.prepare();
    const path = join(this.directory, "credentials.lock");
    const deadline = Date.now() + 5000;
    while (true) {
      signal.throwIfAborted();
      try {
        await mkdir(path, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline)
          throw new AppError(
            "AUTH_BUSY",
            "Another process holds the credential lock.",
            1,
            true,
            "Retry later. Remove credentials.lock only after confirming no authentication process is running.",
          );
        await sleep(50, undefined, { signal });
      }
    }
    try {
      return await operation();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }

  /** Return a usable bearer credential, refreshing an expiring OAuth token under the lock. */
  async access(signal: AbortSignal, fetcher: Fetch = fetch): Promise<Access> {
    const credentials = await this.read();
    if (!credentials)
      throw new AppError(
        "AUTH_REQUIRED",
        "No saved credentials were found.",
        1,
        false,
        "Run namestack-domains auth login in a terminal (npx -y @namestack/domains auth login without a global install), or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
      );
    if (credentials.method === "api-token")
      return { method: "api-token", accountId: credentials.accountId, token: credentials.token };
    if (credentials.expiresAt > Date.now() + 60000)
      return { method: "oauth", accountId: credentials.accountId, token: credentials.accessToken };
    return this.locked(signal, async () => {
      const current = await this.read();
      if (!current) throw new AppError("AUTH_REQUIRED", "The saved login was removed.");
      if (current.method === "api-token")
        return { method: "api-token" as const, accountId: current.accountId, token: current.token };
      if (current.expiresAt > Date.now() + 60000)
        return {
          method: "oauth" as const,
          accountId: current.accountId,
          token: current.accessToken,
        };
      if (!current.refreshToken)
        throw new AppError(
          "AUTH_REQUIRED",
          "The OAuth login expired and has no refresh token.",
          1,
          false,
          "Run namestack-domains auth login again.",
        );
      const { refreshTokens } = await import("../providers/oauth.js");
      const tokens = await refreshTokens(
        current.clientId,
        current.refreshToken,
        current.scopes,
        signal,
        fetcher,
      );
      const updated: OAuthCredentials = {
        ...current,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        savedAt: new Date().toISOString(),
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      };
      await this.write(updated);
      return { method: "oauth" as const, accountId: updated.accountId, token: updated.accessToken };
    });
  }
}

function isCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

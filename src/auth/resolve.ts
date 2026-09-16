import { AppError } from "../core/errors.js";
import { Cloudflare } from "../providers/cloudflare.js";
import { CredentialStore, configDirectory, readConfig } from "./store.js";

/** Non-secret configuration plus the credential store, resolved once per command. */
export async function loadSettings(accountId?: string) {
  const directory = configDirectory();
  const config = await readConfig(directory);
  return {
    directory,
    config,
    store: new CredentialStore(directory),
    accountId: accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? config.accountId,
  };
}

/**
 * Build a Registrar client from whatever credential is configured.
 *
 * Shared by every entrypoint so the CLI and the MCP server resolve accounts and
 * tokens identically. It never prompts: a missing credential is an error.
 */
export async function resolveRegistrar(
  accountId: string | undefined,
  signal: AbortSignal,
): Promise<Cloudflare> {
  const settings = await loadSettings(accountId);
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken !== undefined && !envToken.trim())
    throw new AppError("CONFIG_INVALID", "CLOUDFLARE_API_TOKEN is empty.", 2);
  const access = envToken ? undefined : await settings.store.access(signal);
  const account = settings.accountId ?? access?.accountId;
  if (!account)
    throw new AppError(
      "CONFIG_REQUIRED",
      "No Cloudflare account is configured.",
      2,
      false,
      "Run namestack-domains auth login, or set CLOUDFLARE_ACCOUNT_ID.",
    );
  return new Cloudflare(account, envToken ?? access?.token ?? "");
}

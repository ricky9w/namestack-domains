/**
 * Registered Cloudflare OAuth client for this CLI.
 *
 * The client is registered as public, so any Cloudflare user can authorize it
 * and nobody has to register a client of their own. A client ID is public
 * information rather than a secret. An empty value builds without OAuth.
 */
export const BUILT_IN_CLIENT_ID = "d0e29ee9011276bcef0555189cc6478a";

/**
 * Redirect URI registered on the OAuth client.
 *
 * RFC 8252 section 8.4 matches every component of a loopback redirect exactly
 * except the port, so the port here is a placeholder: login asks the operating
 * system for an ephemeral port and sends whichever one it gets. Section 8.3
 * advises the loopback literal over `localhost`, which Cloudflare treats as a
 * different host anyway.
 */
export const REGISTERED_REDIRECT = "http://127.0.0.1:8977/callback";

/** Scopes the grant cannot work without. */
export const REQUIRED_SCOPES = ["registrar-domains.read", "offline_access"];

/**
 * Scopes that improve login but may be declined on the consent screen.
 *
 * Account Settings Read is what makes GET /accounts return a list, so declining
 * it only costs the account picker and the account id gets typed instead.
 */
export const OPTIONAL_SCOPES = ["account-settings.read"];

export function builtInClientId(env = process.env): string {
  return env.NAMESTACK_DOMAINS_OAUTH_CLIENT_ID ?? BUILT_IN_CLIENT_ID;
}

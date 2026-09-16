# namestack-domains

English | [简体中文](README.zh.md)

Check whether a name is available as a domain, and what it costs, through the Cloudflare Registrar API. Read-only: it never buys, registers, transfers, or renews anything.

Ships a CLI for people and an MCP server for agents, both over the same query engine.

## Quick start

### Installation

Requires Node.js 22.18 or newer.

```sh
npm install --global @namestack/domains          # namestack-domains, namestack-domains-mcp
npx @namestack/domains check --name=yourbrand    # or run it without installing
```

To build and install from a clone instead:

```sh
bun install --frozen-lockfile
bun run build
npm pack
npm install --global ./namestack-domains-0.1.0.tgz
```

The installed commands need Node, not Bun. Bun is only used to build.

### Authentication

Run `namestack-domains auth login` and pick a method at the prompt. Credentials are saved, so later commands need no flags. Add `--method=oauth` or `--method=api-token` to skip the prompt.

#### Option A: Authorize with OAuth

The CLI ships a registered Cloudflare OAuth client, so there is nothing to create first. Choose OAuth and authorize in the browser.

The CLI prints the authorization URL before offering to open it, so a copied URL still works when no browser launches. Cloudflare's consent screen is where you choose which accounts the grant covers.

Three scopes are requested. `registrar-domains.read` runs the queries, `offline_access` returns the refresh token that renews access automatically, and `account-settings.read` is optional and only lists your accounts so login can offer a picker — decline it and type the account ID instead.

#### Option B: Authorize with an API token

On the [API Tokens page](https://dash.cloudflare.com/profile/api-tokens), choose **Create Token → Create Custom Token** and grant **Account → Registrar Domains → Read**, restricted to the account you query. Read is enough for every query this tool makes.

Run `auth login`, choose the API token method, and paste it. A token scoped to Registrar alone cannot list accounts, so the CLI asks for the 32-character account ID; it appears in the Cloudflare dashboard address bar. Granting **Account Settings → Read** as well lets the CLI offer a picker.

#### Where credentials are stored

| Path | What it holds |
| --- | --- |
| `~/.config/namestack/domains/credentials.json` | The saved token or OAuth grant, file mode `0600`, unencrypted. |
| `~/.config/namestack/domains/config.json` | Optional non-secret defaults: `accountId`, `clientId`, `scopes`, `redirectUri`. |

`XDG_CONFIG_HOME` moves the whole tree, `NAMESTACK_CONFIG_DIR` replaces the `namestack` level, and `NAMESTACK_DOMAINS_CONFIG_DIR` points this tool at an absolute path.

`CLOUDFLARE_API_TOKEN` takes precedence over saved credentials, which suits CI, and `CLOUDFLARE_ACCOUNT_ID` selects the account. `auth logout` deletes the local credentials and asks Cloudflare to revoke an OAuth grant; an API token must be deleted in the dashboard.

### Usage

Confirm the setup works, then check a name:

```sh
namestack-domains doctor --online
namestack-domains check --name=yourbrand
```

`doctor --online` verifies live Registrar access by checking `example.com`; without `--online` it only reports local configuration. `check --name=yourbrand` checks `yourbrand.com`, `.co`, `.app`, and `.dev`. A domain being unavailable is a normal result, not a failure.

## Command reference

Put the complete command path first, then its options. Every command supports `--help`.

| Command | What it does | How to use it |
| --- | --- | --- |
| `check` | Checks exact domains against the registry in real time. | `--domains=brand.com,brand.dev`, or `--name=brand --extensions=com,co.uk`. |
| `search` | Suggests names from Cloudflare's cached search data. | `--query="coffee studio" --limit=10`, then confirm candidates with `check`. |
| `extensions` | Lists one page of the extensions the API supports. | `--limit=50`, then pass the returned cursor as `--cursor="NEXT"`. |
| `doctor` | Reports local authentication, and live access with `--online`. | Run it first when a query fails. |
| `auth login` | Saves an API token or an OAuth grant. | Needs an interactive terminal. `--method=` skips the method prompt. |
| `auth status` | Shows the credential source, method, and storage path, never a secret. | Local only; it makes no network request. |
| `auth logout` | Deletes saved credentials, revoking an OAuth grant. | `--local` skips revocation. |
| `schema` | Prints JSON Schema for every input and result. | Needs no credentials. |

`check` takes exactly one of `--domains` and `--name`, up to 100 domains, and accepts `--extensions` only with `--name`. `search` takes 1–100 characters and a limit of 1–50. `extensions` takes a limit of 1–50 and returns `cursor: null` on the final page.

### Common options and defaults

| Option | What it controls |
| --- | --- |
| `--account-id=ID` | Selects the account, and skips the account prompt during login. |
| `--format=auto\|json\|human` | `auto` prints human output to a terminal outside CI, and JSON otherwise. Only `schema` always prints JSON. |
| `--no-input` | Disables prompts and browser login. Queries never start a login on their own. |
| `--quiet`, `--no-color` | Suppress progress, disable color. A nonempty `NO_COLOR` and `TERM=dumb` also disable color. |
| `--timeout=SECONDS` | Total deadline, 1–600. Queries default to 30, login to 180. |
| `--env-file=PATH` | Loads a dotenv file for this call. Existing environment values win. |

Exit codes: `0` success, including unavailable domains; `1` operational failure; `2` invalid usage or configuration; `124` timeout; `130` and `143` interrupted.

## Read the results

- `registrable: true` means Cloudflare reports the domain as registrable. Search results still need a real-time `check`.
- `registrable: false` must be read with `reason`, which separates taken names, premium tiers, unsupported extensions, and registry restrictions.
- `registrable: null` means the check reached no conclusion. Read that record's `error`; a partial batch keeps the other results and returns `PARTIAL_FAILURE`.
- `pricing` gives the currency, first-year price, and yearly renewal as decimal strings. A missing price is not a free domain.
- Every result carries `operation`, `source`, `checkedAt`, `count`, `cursor`, and `truncated`. `authoritative` and `cache` separate live checks from cached suggestions.

Registrability is a snapshot. It reserves nothing and says nothing about trademarks.

## Use with AI agents and scripts

Data commands write exactly one newline-terminated envelope to stdout, with diagnostics on stderr:

```json
{"schemaVersion":1,"ok":true,"data":{}}
{"schemaVersion":1,"ok":false,"error":{"code":"AUTH_REQUIRED","message":"No saved credentials were found.","retryable":false}}
```

For scripted use, select JSON and disable interaction explicitly:

```sh
namestack-domains check --name=yourbrand --format=json --no-input
namestack-domains schema --format=json
```

JSON mode never starts a spinner or a browser login, and missing credentials fail immediately instead of prompting.

**Agent skill.** The bundled [skill](skills/namestack-domains/SKILL.md) tells an agent how to bound queries and interpret results. Install the CLI first; the skill neither installs the executable nor authenticates it.

**MCP server.** `namestack-domains-mcp` serves the same operations over stdio:

```json
{
  "mcpServers": {
    "namestack-domains": { "command": "namestack-domains-mcp" }
  }
}
```

It exposes `domains_check`, `domains_search`, and `domains_extensions`, each annotated read-only with a strict input and output schema. Results arrive as `structuredContent` carrying the envelope above, and an operational failure returns `isError` rather than closing the connection. It reads the same saved credentials as the CLI and never prompts.

## Development

```sh
bun install --frozen-lockfile
bun run dev -- check --name=example   # run the CLI from source
bun run typecheck                     # tsc --noEmit
bun run lint                          # biome
bun run test                          # node:test
bun run build                         # tsdown, emits dist/cli.mjs and dist/mcp.mjs
```

Responsibilities are split by directory: `core/` owns the domain operations and result contracts, `providers/` owns Cloudflare requests and normalization, `auth/` owns credential storage and resolution, and `cli/` and `mcp/` adapt the same core operations to their transports. Keep terminal output, prompts, and process exits out of `core/`, and contain upstream format changes inside `providers/`.

Tests use fixtures and mocked transports; none of them reach Cloudflare.

## License

[MIT](LICENSE)

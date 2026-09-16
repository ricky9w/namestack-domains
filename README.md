# namestack-domains

English | [简体中文](README.zh.md)

Check whether a name is available as a domain, and what it costs, through the Cloudflare Registrar API. Read-only: it never buys, registers, transfers, or renews anything.

One command serves both audiences over the same query engine: a CLI for people, and `namestack-domains mcp`, an MCP server for agents.

## Quick start

### Installation

Requires Node.js 22.18 or newer.

```sh
npm install --global @namestack/domains            # installs namestack-domains
npx -y @namestack/domains check --name=yourbrand   # or run it without installing
```

To build and install from a clone instead:

```sh
bun install --frozen-lockfile
bun run build
npm pack
npm install --global ./namestack-domains-*.tgz
```

The installed command needs Node, not Bun. Bun is only used to build.

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

`CLOUDFLARE_API_TOKEN` takes precedence over saved credentials, which suits CI, and `CLOUDFLARE_ACCOUNT_ID` selects the account; without it, an environment token uses the account of the saved login. `auth logout` deletes the local credentials and asks Cloudflare to revoke an OAuth grant; an API token must be deleted in the dashboard.

### Usage

Confirm the setup works, then check a name:

```sh
namestack-domains doctor --online
namestack-domains check --name=yourbrand
```

`doctor --online` verifies live Registrar access by checking `example.com`; without `--online` it only reports local configuration. `check --name=yourbrand` checks that label across 12 default extensions: `com`, `io`, `ai`, `app`, `dev`, `co`, `net`, `shop`, `store`, `online`, `site`, and `info`. Pass `--extensions=` to choose your own; all of them go out in one request. A domain being unavailable is a normal result, not a failure.

To query from Claude Code or another MCP host instead, see [MCP server](#mcp-server).

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
| `mcp` | Serves the query tools to an MCP host over stdio. | The host starts it; see [MCP server](#mcp-server). |

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

### Scripts

Data commands write exactly one newline-terminated envelope to stdout, with diagnostics on stderr:

```json
{"schemaVersion":1,"ok":true,"data":{}}
{"schemaVersion":1,"ok":false,"error":{"code":"AUTH_REQUIRED","message":"No saved credentials were found.","retryable":false}}
```

Select JSON and disable interaction explicitly:

```sh
namestack-domains check --name=yourbrand --format=json --no-input
namestack-domains schema --format=json
```

JSON mode never starts a spinner or a browser login, and missing credentials fail immediately instead of prompting.

### Agent skill

The bundled [skill](skills/namestack-domains/SKILL.md) tells an agent how to bound queries and interpret results through the CLI. Install the CLI first; the skill neither installs the executable nor authenticates it.

### MCP server

`namestack-domains mcp` serves the queries to an MCP host over stdio. The host starts and stops the process; you do not run it yourself.

#### Set up in Claude Code

1. Authenticate once in a terminal with `namestack-domains auth login`, or `npx -y @namestack/domains auth login` without a global install. To skip this step, pass a token instead; see [Credentials](#credentials).
2. Register the server. `--scope user` makes it available in every project:

   ```sh
   claude mcp add namestack-domains --scope user -- namestack-domains mcp
   ```

3. Run `claude mcp list` and look for `✔ Connected`. In a session, `/mcp` lists the three tools. Add the rule `mcp__namestack-domains` with `/permissions` to allow all three without prompts.

Other hosts take the same command in their JSON configuration. If a host cannot find the command, use the absolute path from `command -v namestack-domains`.

```json
{
  "mcpServers": {
    "namestack-domains": { "command": "namestack-domains", "args": ["mcp"] }
  }
}
```

#### Launch command

| Command | Behavior |
| --- | --- |
| `namestack-domains mcp` | Runs the global install and never contacts npm at startup. Upgrade with `npm install --global @namestack/domains@latest`. |
| `npx -y @namestack/domains mcp` | Needs no install and picks up new releases, because npx checks the registry on every start. Offline, npx retries for about 70 seconds before using its cache, which exceeds Claude Code's 30-second startup limit. |
| `npx -y --prefer-offline @namestack/domains mcp` | Skips the registry check, so it starts offline but does not look for new releases. |

The first npx start downloads the package. Authenticating through npx in step 1 caches it in advance; otherwise raise the limit with `MCP_TIMEOUT=60000 claude`.

#### Credentials

The server resolves credentials on every call, exactly as the CLI does, and never prompts: `CLOUDFLARE_API_TOKEN` first, then the saved login. An OAuth login refreshes itself, and a login made while the host is running applies from the next call.

A host does not necessarily pass your shell environment to the server, so set a token explicitly, together with the account:

```sh
claude mcp add namestack-domains --scope user \
  -e CLOUDFLARE_API_TOKEN=<token> \
  -e CLOUDFLARE_ACCOUNT_ID=<account-id> \
  -- namestack-domains mcp
```

Claude Code keeps these values in plain text in `~/.claude.json`, and the command leaves the token in your shell history. If you moved the credential directory, pass `XDG_CONFIG_HOME` or `NAMESTACK_DOMAINS_CONFIG_DIR` the same way.

For a team, `--scope project` writes a `.mcp.json` to commit. Keep tokens out of it, and have each member authenticate on their own machine:

```json
{
  "mcpServers": {
    "namestack-domains": { "command": "npx", "args": ["-y", "@namestack/domains", "mcp"] }
  }
}
```

If every member uses a token, reference it in an `env` block as `"${CLOUDFLARE_API_TOKEN}"` and `"${CLOUDFLARE_ACCOUNT_ID}"` rather than writing the values.

#### Tools

| Tool | Input |
| --- | --- |
| `domains_check` | Takes `domains` (1–100 complete domains), or `name` with optional `extensions`, which default to the 12 listed under [Usage](#usage). |
| `domains_search` | Takes `query` with optional `extensions` and `limit` (1–50, default 20). Confirm its suggestions with `domains_check`. |
| `domains_extensions` | Takes optional `limit` (1–50, default 50) and the `cursor` of the previous page. |

All three are annotated read-only and declare strict input and output schemas. Results arrive as `structuredContent` carrying the envelope shown under [Scripts](#scripts). An operational failure, including missing credentials, returns `isError` with the same envelope and leaves the server running.

## Development

```sh
bun install --frozen-lockfile
bun run dev -- check --name=example   # run the CLI from source
bun run typecheck                     # tsc --noEmit
bun run lint                          # biome
bun run test                          # node:test
bun run build                         # tsdown, emits dist/cli.mjs
```

Responsibilities are split by directory: `core/` owns the domain operations and result contracts, `providers/` owns Cloudflare requests and normalization, `auth/` owns credential storage and resolution, and `cli/` and `mcp/` adapt the same core operations to their transports. Keep terminal output, prompts, and process exits out of `core/`, and contain upstream format changes inside `providers/`.

Tests use fixtures and mocked transports; none of them reach Cloudflare.

## License

[MIT](LICENSE)

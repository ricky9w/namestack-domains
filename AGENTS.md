# Agent instructions

- Keep this package limited to read-only Cloudflare Registrar queries and authentication. Do not add domain registration, other providers, or browser scraping.
- Read [README.md](README.md) for commands, authentication, contracts, architecture, and validation.
- Keep command definitions lightweight and put Cloudflare wire formats in providers. Preserve per-domain failures and distinguish registration eligibility from registration history.
- Never include real credentials in tests, fixtures, output, or commits. Keep OAuth client registration and account authorization as explicit user setup.
- Maintain README.md in English and README.zh.md in Simplified Chinese as matching language editions. Update both with interface changes and preserve their language-switch links. Keep documentation concise and do not create research journals.
- Organize the README for first-time users: introduce the tool, guide installation and a choice of independent authentication methods, explain credential storage and first queries, then provide command references. Put implementation and maintainer diagnostics last; do not present setup as a history of development or testing.
- Follow the workspace DEVELOPMENT.md while working in Namestack; this package must remain independently buildable and testable.

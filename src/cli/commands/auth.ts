import { defineCommand } from "citty";
import { accountArgs, commonArgs } from "../args.js";

export default defineCommand({
  meta: { name: "auth", description: "Sign in to Cloudflare and inspect saved credentials." },
  args: commonArgs,
  subCommands: {
    login: defineCommand({
      meta: {
        name: "login",
        description: "Save Cloudflare credentials from an API token or a browser OAuth grant.",
      },
      args: {
        ...commonArgs,
        ...accountArgs,
        method: {
          type: "enum",
          options: ["api-token", "oauth"],
          description: "Skip the method prompt and use this authentication method.",
        },
        "client-id": {
          type: "string",
          description: "Override the built-in Cloudflare OAuth client ID.",
        },
        scopes: {
          type: "string",
          description: "Request these comma-separated OAuth scope IDs instead of the defaults.",
        },
        "redirect-uri": {
          type: "string",
          description:
            "Use a registered loopback callback (default: http://127.0.0.1:8977/callback).",
        },
      },
      async run({ args, data }) {
        return (await import("../authentication.js")).login(args, data);
      },
    }),
    status: defineCommand({
      meta: {
        name: "status",
        description: "Inspect local authentication without network requests or secrets.",
      },
      args: commonArgs,
      async run() {
        return (await import("../authentication.js")).status();
      },
    }),
    logout: defineCommand({
      meta: {
        name: "logout",
        description: "Remove saved credentials, revoking an OAuth grant when one is present.",
      },
      args: {
        ...commonArgs,
        local: {
          type: "boolean",
          description: "Remove local credentials without remote revocation.",
        },
      },
      async run({ args, data }) {
        return (await import("../authentication.js")).logout(args, data);
      },
    }),
  },
});

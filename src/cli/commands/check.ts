import { defineCommand } from "citty";
import { accountArgs, commonArgs } from "../args.js";

export default defineCommand({
  meta: {
    name: "check",
    description: "Check exact domains or a name across extensions in real time.",
  },
  args: {
    ...commonArgs,
    ...accountArgs,
    domains: { type: "string", description: "Check 1–100 comma-separated complete domains." },
    name: { type: "string", description: "Check one domain label across extensions." },
    extensions: {
      type: "string",
      description: "Use comma-separated extensions with --name (default: com,co,app,dev).",
    },
  },
  async run({ args, data }) {
    return (await import("../queries.js")).check(args, data);
  },
});

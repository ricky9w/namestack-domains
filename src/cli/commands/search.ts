import { defineCommand } from "citty";
import { accountArgs, commonArgs } from "../args.js";

export default defineCommand({
  meta: {
    name: "search",
    description: "Discover suggestions using Cloudflare's cached search data.",
  },
  args: {
    ...commonArgs,
    ...accountArgs,
    query: {
      type: "string",
      required: true,
      description: "Search a keyword, phrase, or full domain.",
    },
    extensions: {
      type: "string",
      description:
        "Filter by comma-separated extensions; unsupported values may be ignored by Cloudflare.",
    },
    limit: { type: "string", default: "20", description: "Return up to 1–50 suggestions." },
  },
  async run({ args, data }) {
    return (await import("../queries.js")).search(args, data);
  },
});

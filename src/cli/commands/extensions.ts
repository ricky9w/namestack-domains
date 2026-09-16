import { defineCommand } from "citty";
import { accountArgs, commonArgs } from "../args.js";

export default defineCommand({
  meta: { name: "extensions", description: "List one page of API-supported domain extensions." },
  args: {
    ...commonArgs,
    ...accountArgs,
    limit: { type: "string", default: "50", description: "Return up to 1–50 extensions." },
    cursor: { type: "string", description: "Continue with the cursor from the previous result." },
  },
  async run({ args, data }) {
    return (await import("../queries.js")).extensions(args, data);
  },
});

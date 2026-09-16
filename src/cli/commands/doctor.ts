import { defineCommand } from "citty";
import { accountArgs, commonArgs } from "../args.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect local setup; optionally verify the Registrar check endpoint.",
  },
  args: {
    ...commonArgs,
    ...accountArgs,
    online: { type: "boolean", description: "Check example.com to verify live Registrar access." },
  },
  async run({ args, data }) {
    return (await import("../queries.js")).doctor(args, data);
  },
});

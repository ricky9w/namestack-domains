import { defineCommand } from "citty";
import { commonArgs } from "../args.js";

export default defineCommand({
  meta: {
    name: "schema",
    description: "Print versioned query and result schemas without authentication.",
  },
  args: commonArgs,
  async run() {
    return (await import("../queries.js")).schema();
  },
});

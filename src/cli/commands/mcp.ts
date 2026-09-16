import { defineCommand } from "citty";
import { commonArgs } from "../args.js";

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Serve the query tools to an MCP host over stdio.",
  },
  args: { help: commonArgs.help },
});

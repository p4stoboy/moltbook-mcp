/**
 * @module server
 * MCP server factory. Instantiates the McpServer and registers all Moltbook tools.
 * Separated from index.ts so the server can be created without immediately
 * binding a transport (useful for testing).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

/** Creates a configured MCP server with all Moltbook tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "moltbook", version: "0.1.0" });
  registerTools(server);
  return server;
}

/**
 * @module index
 * Entry point for the Moltbook MCP server.
 * Creates the server and connects it to stdio transport using top-level await.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

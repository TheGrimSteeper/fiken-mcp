#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { createHttpServer, httpConfig } from "./http.js";

if (process.env.FIKEN_MCP_TRANSPORT === "http") {
    const config = httpConfig();
    // Each request builds its own server; build one now so bad settings stop the start.
    createMcpServer();
    createHttpServer(config.token, createMcpServer).listen(config.port, config.host, () => {
        console.error(`fiken-mcp listening on http://${config.host}:${config.port}/mcp`);
    });
} else {
    await createMcpServer().connect(new StdioServerTransport());
}

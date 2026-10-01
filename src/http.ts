import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpConfig {
    token: string;
    port: number;
    host: string;
}

/** Validate HTTP mode settings. Refuses to start with a missing or weak token. */
export function httpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
    const token = env.FIKEN_MCP_TOKEN ?? "";
    if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) {
        throw new Error("FIKEN_MCP_TOKEN must contain at least 43 random URL-safe characters");
    }
    if (!env.FIKEN_API_TOKEN) throw new Error("FIKEN_API_TOKEN environment variable is required");
    if (!env.FIKEN_COMPANY_SLUG) {
        throw new Error("FIKEN_COMPANY_SLUG environment variable is required");
    }
    const port = Number(env.FIKEN_MCP_PORT ?? 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("FIKEN_MCP_PORT must be a valid port number");
    }
    return { token, port, host: env.FIKEN_MCP_HOST ?? "0.0.0.0" };
}

function authorised(header: string | undefined, token: string): boolean {
    const expected = Buffer.from(`Bearer ${token}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    );
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("BODY_TOO_LARGE"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(new Error("INVALID_JSON"));
            }
        });
    });
}

/**
 * Stateless streamable-HTTP MCP endpoint at /mcp. Each request gets a fresh MCP
 * server and transport; all of them share the process-wide Fiken request limiter.
 */
export function createHttpServer(token: string, makeServer: () => McpServer): http.Server {
    return http.createServer(async (req, res) => {
        // req.url is always set on requests received by an http.Server.
        const path = new URL(req.url as string, "http://localhost").pathname;
        if (path !== "/mcp") return sendJson(res, 404, "Not found");
        if (!authorised(req.headers.authorization, token)) {
            return sendJson(res, 401, "Unauthorized");
        }
        if (req.method !== "POST") return sendJson(res, 405, "Method not allowed");

        let body: unknown;
        try {
            body = await readBody(req);
        } catch (e) {
            const tooLarge = (e as Error).message === "BODY_TOO_LARGE";
            return sendJson(
                res,
                tooLarge ? 413 : 400,
                tooLarge ? "Body too large" : "Invalid JSON",
            );
        }

        const server = makeServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    });
}

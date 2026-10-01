import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHttpServer, httpConfig } from "../http.js";

const TOKEN = "a".repeat(43);

function makeServer() {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool(
        "echo",
        { description: "echo", inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
    );
    return server;
}

describe("httpConfig", () => {
    const base = { FIKEN_MCP_TOKEN: TOKEN, FIKEN_API_TOKEN: "x", FIKEN_COMPANY_SLUG: "s" };

    it("accepts a strong token and applies defaults", () => {
        expect(httpConfig(base)).toEqual({ token: TOKEN, port: 8080, host: "0.0.0.0" });
        expect(
            httpConfig({ ...base, FIKEN_MCP_PORT: "9000", FIKEN_MCP_HOST: "127.0.0.1" }),
        ).toEqual({ token: TOKEN, port: 9000, host: "127.0.0.1" });
    });

    it("refuses missing, short or non-URL-safe tokens", () => {
        for (const t of [undefined, "short", "a".repeat(42), "a".repeat(42) + "/"]) {
            expect(() => httpConfig({ ...base, FIKEN_MCP_TOKEN: t })).toThrow("FIKEN_MCP_TOKEN");
        }
    });

    it("requires the Fiken credentials at startup", () => {
        expect(() => httpConfig({ ...base, FIKEN_API_TOKEN: "" })).toThrow("FIKEN_API_TOKEN");
        expect(() => httpConfig({ ...base, FIKEN_COMPANY_SLUG: "" })).toThrow("FIKEN_COMPANY_SLUG");
    });

    it("rejects invalid ports", () => {
        for (const p of ["-1", "65536", "abc", "1.5"]) {
            expect(() => httpConfig({ ...base, FIKEN_MCP_PORT: p })).toThrow("FIKEN_MCP_PORT");
        }
    });
});

describe("createHttpServer", () => {
    let server: http.Server;
    let url: string;

    beforeAll(async () => {
        server = createHttpServer(TOKEN, makeServer);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    const headers = (auth = `Bearer ${TOKEN}`) => ({
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
    });

    const rpc = (method: string, params: unknown = {}, auth?: string) =>
        fetch(`${url}/mcp`, {
            method: "POST",
            headers: headers(auth),
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });

    it("serves MCP initialize, tools/list and tools/call", async () => {
        const init = await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
        });
        expect(init.status).toBe(200);
        expect((await init.json()).result.serverInfo.name).toBe("test");

        const list = await rpc("tools/list");
        expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toEqual([
            "echo",
        ]);

        const call = await rpc("tools/call", { name: "echo", arguments: { text: "hei" } });
        expect((await call.json()).result.content[0].text).toBe("hei");
    });

    it("answers ping for health checks", async () => {
        const r = await rpc("ping");
        expect(r.status).toBe(200);
        expect((await r.json()).result).toEqual({});
    });

    it("rejects a request with no Authorization header at all", async () => {
        const r = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(r.status).toBe(401);
    });

    it("rejects missing and wrong bearer tokens", async () => {
        for (const auth of ["", `Bearer ${"b".repeat(43)}`, `Bearer ${TOKEN}x`, TOKEN]) {
            const r = await rpc("ping", {}, auth);
            expect(r.status).toBe(401);
        }
    });

    it("only serves POST /mcp", async () => {
        expect((await fetch(`${url}/other`, { headers: headers() })).status).toBe(404);
        expect((await fetch(url, { headers: headers() })).status).toBe(404);
        expect((await fetch(`${url}/mcp`, { headers: headers() })).status).toBe(405);
    });

    it("rejects invalid JSON and oversized bodies", async () => {
        const bad = await fetch(`${url}/mcp`, { method: "POST", headers: headers(), body: "{" });
        expect(bad.status).toBe(400);
        const big = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ pad: "x".repeat(1024 * 1024) }),
        }).catch(() => null);
        // The server answers 413 and drops the socket; either outcome means rejection.
        if (big) expect(big.status).toBe(413);
    });
});

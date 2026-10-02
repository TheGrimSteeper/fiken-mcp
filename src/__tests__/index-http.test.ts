import { vi, describe, it, expect, beforeAll } from "vitest";

const listen = vi.fn((_port: number, _host: string, cb: () => void) => cb());
const createHttpServer = vi.fn(() => ({ listen }));
const httpConfig = vi.fn(() => ({ token: "t".repeat(43), port: 9999, host: "127.0.0.1" }));
const createMcpServer = vi.fn();
const MockStdioTransport = vi.fn();

vi.mock("../http.js", () => ({ createHttpServer, httpConfig }));
vi.mock("../server.js", () => ({ createMcpServer }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
    StdioServerTransport: MockStdioTransport,
}));

describe("index (http mode)", () => {
    beforeAll(async () => {
        process.env.FIKEN_MCP_TRANSPORT = "http";
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await import("../index.js");
        delete process.env.FIKEN_MCP_TRANSPORT;
    });

    it("starts the HTTP server with the validated config", () => {
        expect(httpConfig).toHaveBeenCalledOnce();
        expect(createHttpServer).toHaveBeenCalledWith("t".repeat(43), createMcpServer);
        expect(listen).toHaveBeenCalledWith(9999, "127.0.0.1", expect.any(Function));
    });

    it("builds one server before listening, so bad settings stop the start", () => {
        expect(createMcpServer).toHaveBeenCalledOnce();
        expect(createMcpServer.mock.invocationCallOrder[0]).toBeLessThan(
            listen.mock.invocationCallOrder[0],
        );
    });

    it("does not start stdio", () => {
        expect(MockStdioTransport).not.toHaveBeenCalled();
    });
});

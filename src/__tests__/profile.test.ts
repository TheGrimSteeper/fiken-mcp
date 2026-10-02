import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    DRAFT_TOOLS,
    PRIVATE_TRANSFER_TOOL,
    assertAllRegistered,
    draftTools,
    restrictTools,
    toolProfile,
} from "../profile.js";

describe("toolProfile", () => {
    it("defaults to full and accepts drafts", () => {
        expect(toolProfile({})).toBe("full");
        expect(toolProfile({ FIKEN_TOOL_PROFILE: "full" })).toBe("full");
        expect(toolProfile({ FIKEN_TOOL_PROFILE: "drafts" })).toBe("drafts");
    });

    it("refuses unknown profiles", () => {
        for (const value of ["", "DRAFTS", "readonly"]) {
            expect(() => toolProfile({ FIKEN_TOOL_PROFILE: value })).toThrow("FIKEN_TOOL_PROFILE");
        }
    });
});

describe("draftTools", () => {
    const settings = {
        FIKEN_PRIVATE_BANK_ACCOUNTS: "11112233445",
        FIKEN_PRIVATE_LEDGER_ACCOUNT: "2061",
    };

    it("leaves the booking tool out unless it is switched on", () => {
        expect(draftTools({})).toBe(DRAFT_TOOLS);
        expect(draftTools()).toBe(DRAFT_TOOLS);
        expect(draftTools({ ...settings, FIKEN_PRIVATE_TRANSFERS: "off" })).toBe(DRAFT_TOOLS);
        expect(DRAFT_TOOLS.has(PRIVATE_TRANSFER_TOOL)).toBe(false);
    });

    it("adds the booking tool when it is switched on and configured", () => {
        const tools = draftTools({ ...settings, FIKEN_PRIVATE_TRANSFERS: "on" });
        expect([...tools].sort()).toEqual([...DRAFT_TOOLS, PRIVATE_TRANSFER_TOOL].sort());
    });

    it("fails when it is switched on without its settings", () => {
        expect(() => draftTools({ FIKEN_PRIVATE_TRANSFERS: "on" })).toThrow(
            "PRIVATE_TRANSFERS_NOT_CONFIGURED",
        );
        expect(() => draftTools({ ...settings, FIKEN_PRIVATE_TRANSFERS: "yes" })).toThrow(
            "FIKEN_PRIVATE_TRANSFERS",
        );
    });
});

describe("restrictTools", () => {
    it("registers only allowed tools and passes other members through", () => {
        const registerTool = vi.fn(() => "handle");
        const inner = { registerTool, connect: "connect-member" } as unknown as McpServer;
        const { server, registered } = restrictTools(inner, new Set(["keep"]));

        expect(server.registerTool("keep", {}, async () => ({ content: [] }))).toBe("handle");
        expect(server.registerTool("drop", {}, async () => ({ content: [] }))).toBeUndefined();
        expect(registerTool).toHaveBeenCalledOnce();
        expect(registerTool).toHaveBeenCalledWith("keep", {}, expect.any(Function));
        expect(registered()).toEqual(["keep"]);
        expect((server as unknown as { connect: string }).connect).toBe("connect-member");
    });
});

describe("assertAllRegistered", () => {
    it("passes when every allowed tool exists and names the missing ones otherwise", () => {
        expect(() => assertAllRegistered(new Set(["a", "b"]), ["b", "a"])).not.toThrow();
        expect(() => assertAllRegistered(new Set(["a", "b", "c"]), ["a"])).toThrow(
            "Tool profile lists tools that do not exist: b, c",
        );
    });
});

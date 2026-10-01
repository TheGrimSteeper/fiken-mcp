import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolProfile = "full" | "drafts";

/**
 * Tools available in the "drafts" profile. Everything else (finalising purchases,
 * deletes, invoices, sales, payments, journal entries, ...) is never registered.
 */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set([
    // Reads
    "fiken_list_accounts",
    "fiken_list_account_balances",
    "fiken_list_bank_accounts",
    "fiken_list_contacts",
    "fiken_get_contact",
    "fiken_list_inbox",
    "fiken_list_purchases",
    "fiken_list_purchase_drafts",
    "fiken_get_purchase_draft",
    "fiken_get_purchase_draft_attachments",
    // Writes limited to drafts and supplier master data
    "fiken_create_purchase_draft",
    "fiken_update_purchase_draft",
    "fiken_create_supplier",
]);

export function toolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
    const value = env.FIKEN_TOOL_PROFILE ?? "full";
    if (value !== "full" && value !== "drafts") {
        throw new Error('FIKEN_TOOL_PROFILE must be "full" or "drafts"');
    }
    return value;
}

/**
 * Wrap `server` so `registerTool` only registers names in `allowed`. Returns the
 * wrapper and a function that lists the names actually registered.
 */
export function restrictTools(
    server: McpServer,
    allowed: ReadonlySet<string>,
): { server: McpServer; registered: () => string[] } {
    const names: string[] = [];
    const wrapper = new Proxy(server, {
        get(target, prop, receiver) {
            if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
            return (name: string, ...rest: unknown[]) => {
                if (!allowed.has(name)) return undefined;
                names.push(name);
                return (target.registerTool as (...args: unknown[]) => unknown)(name, ...rest);
            };
        },
    });
    return { server: wrapper, registered: () => [...names] };
}

/** Fail fast when an allowlisted tool was not registered, e.g. after an upstream rename. */
export function assertAllRegistered(allowed: ReadonlySet<string>, registered: string[]): void {
    const missing = [...allowed].filter((name) => !registered.includes(name));
    if (missing.length > 0) {
        throw new Error(`Tool profile lists tools that do not exist: ${missing.join(", ")}`);
    }
}

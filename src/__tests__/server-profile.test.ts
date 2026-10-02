import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { DRAFT_TOOLS, type ToolProfile } from "../profile.js";

async function toolNames(profile: ToolProfile) {
    const server = createMcpServer(profile);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    return { client, tools, names: tools.map((t) => t.name).sort() };
}

const FORBIDDEN = [
    "fiken_create_purchase",
    "fiken_create_purchase_from_draft",
    "fiken_delete_purchase",
    "fiken_delete_purchase_draft",
    "fiken_add_purchase_attachment",
    "fiken_create_contact",
    "fiken_delete_contact",
    "fiken_create_invoice",
    "fiken_send_invoice",
    "fiken_create_journal_entry",
    "fiken_create_sale",
];

describe("createMcpServer tool profiles", () => {
    it("drafts exposes exactly the draft allowlist", async () => {
        const { names } = await toolNames("drafts");
        expect(names).toEqual([...DRAFT_TOOLS].sort());
        for (const name of FORBIDDEN) expect(names).not.toContain(name);
    });

    it("drafts rejects calls to tools outside the allowlist", async () => {
        const { client } = await toolNames("drafts");
        const result = await client.callTool({
            name: "fiken_create_purchase_from_draft",
            arguments: { draftId: 1 },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("not found");
    });

    it("drafts advertises the parameters of the draft tool", async () => {
        const { tools } = await toolNames("drafts");
        const schema = tools.find((t) => t.name === "fiken_create_purchase_draft_from_paperless")
            ?.inputSchema as {
            required: string[];
            properties: Record<
                string,
                { items?: { properties?: Record<string, { enum?: string[] }> } }
            >;
        };
        expect(schema.required).toEqual(
            expect.arrayContaining([
                "paperlessDocumentId",
                "invoiceIssueDate",
                "cash",
                "paid",
                "totalGross",
                "lines",
            ]),
        );
        expect(schema.properties.lines.items?.properties?.vatType.enum).toContain("HIGH");
    });

    it("drafts rejects a total that the lines do not add up to", async () => {
        const { client } = await toolNames("drafts");
        const result = await client.callTool({
            name: "fiken_create_purchase_draft_from_paperless",
            arguments: {
                paperlessDocumentId: 42,
                invoiceIssueDate: "2026-09-28",
                cash: true,
                paid: true,
                totalGross: 59900,
                lines: [
                    {
                        text: "Fiskesluk",
                        account: "6540",
                        vatType: "HIGH",
                        net: 39920,
                        gross: 49900,
                    },
                ],
            },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("lines add up to 49900");
    });

    it("full keeps every upstream tool plus the fork's three tools", async () => {
        const { names } = await toolNames("full");
        expect(names.length).toBe(109);
        expect(names).toContain("fiken_create_purchase_from_draft");
        expect(names).toContain("fiken_create_supplier");
        expect(names).toContain("fiken_create_purchase_draft_from_paperless");
        expect(names).toContain("fiken_get_paperless_import_status");
        // Proves the forbidden-list names are real, so the drafts check above is meaningful.
        for (const name of FORBIDDEN) expect(names).toContain(name);
    });
});

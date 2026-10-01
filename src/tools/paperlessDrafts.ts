import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cp, mutate, uploadMultipart } from "../client.js";
import { fetchForFiken } from "../paperless.js";
import { audit, getDocument, updateDocument, withStateLock } from "../store.js";
import { accountCode, checkLines, isoDate, ore, purchaseLine } from "../validation.js";

const TOOL = "fiken_create_purchase_draft_from_paperless";

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true as const,
    };
}
function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** The numeric id at the end of a Location header such as .../inbox/123. */
export function idFromLocation(location: unknown): number | undefined {
    const match = typeof location === "string" ? /\/(\d+)\/?$/.exec(location) : null;
    return match ? Number(match[1]) : undefined;
}

export const draftInput = z
    .object({
        paperlessDocumentId: z.number().int().positive().describe("Paperless-ngx document id"),
        invoiceIssueDate: isoDate.describe("Receipt or invoice date, YYYY-MM-DD"),
        dueDate: isoDate.optional().describe("Due date for unpaid invoices, YYYY-MM-DD"),
        invoiceNumber: z
            .string()
            .min(1)
            .optional()
            .describe("Supplier's invoice or receipt number"),
        contactId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Fiken supplier contact id, from fiken_list_contacts"),
        cash: z.boolean().describe("True for a cash/card purchase paid on the spot"),
        paid: z.boolean().describe("True if already paid"),
        currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code such as NOK")
            .default("NOK"),
        kid: z
            .string()
            .regex(/^\d{2,25}$/, "KID must be 2 to 25 digits")
            .optional(),
        projectId: z.number().int().positive().optional(),
        payments: z
            .array(
                z.object({
                    date: isoDate,
                    account: accountCode.describe('Payment account, e.g. "1920:10001"'),
                    amount: ore.describe("Amount paid in øre"),
                }),
            )
            .optional(),
        totalGross: ore.describe("Total on the receipt in øre, including VAT"),
        lines: z.array(purchaseLine).min(1),
        confirmRetry: z
            .boolean()
            .optional()
            .describe(
                "Only after checking fiken_list_purchase_drafts that an earlier failed attempt did not create a draft",
            ),
    })
    .superRefine((input, ctx) => checkLines(input.lines, input.totalGross, ctx));

type DraftInput = z.infer<typeof draftInput>;

async function importToInbox(id: number): Promise<number> {
    const file = await fetchForFiken(id);
    const form = new FormData();
    form.append(
        "file",
        new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
        file.filename,
    );
    form.append("name", file.filename);
    form.append("filename", file.filename);
    form.append("description", `Paperless #${id}`);
    const result = (await uploadMultipart(cp("/inbox"), undefined, form)) as { location?: unknown };
    const inboxDocumentId = idFromLocation(result?.location);
    if (inboxDocumentId === undefined) {
        throw new Error(
            "INBOX_ID_UNKNOWN: Fiken accepted the upload but returned no document id; find it with fiken_list_inbox",
        );
    }
    return inboxDocumentId;
}

function draftBody(input: DraftInput) {
    return {
        invoiceIssueDate: input.invoiceIssueDate,
        dueDate: input.dueDate,
        invoiceNumber: input.invoiceNumber,
        contactId: input.contactId,
        projectId: input.projectId,
        cash: input.cash,
        paid: input.paid,
        currency: input.currency,
        kid: input.kid,
        payments: input.payments,
        lines: input.lines.map((line) => ({
            text: line.text,
            vatType: line.vatType,
            incomeAccount: line.account,
            net: line.net,
            gross: line.gross,
            projectId: line.projectId,
        })),
    };
}

/** Resume-safe flow: Paperless → Fiken inbox → purchase draft → attach. */
async function createDraft(input: DraftInput) {
    const id = input.paperlessDocumentId;
    const base = { tool: TOOL, paperlessDocumentId: id, totalGross: input.totalGross };
    let doc = await getDocument(id);

    if (doc.draftId !== undefined && doc.attachedAt) {
        return ok({ ...doc, paperlessDocumentId: id, alreadyDrafted: true });
    }
    if (doc.draftId === undefined && doc.draftAttemptedAt && !input.confirmRetry) {
        return err(
            "RETRY_NEEDS_CONFIRMATION: an earlier attempt may already have created a draft for this document. " +
                "Check fiken_list_purchase_drafts; if there is none, call again with confirmRetry: true.",
        );
    }

    if (doc.inboxDocumentId === undefined) {
        try {
            const inboxDocumentId = await importToInbox(id);
            doc = await updateDocument(id, {
                inboxDocumentId,
                importedAt: new Date().toISOString(),
            });
            await audit({ ...base, event: "inbox_import", ok: true, inboxDocumentId });
        } catch (e) {
            await audit({ ...base, event: "inbox_import", ok: false, error: message(e) });
            return err(message(e));
        }
    }
    const inboxDocumentId = doc.inboxDocumentId as number;

    if (doc.draftId === undefined) {
        await updateDocument(id, { draftAttemptedAt: new Date().toISOString() });
        try {
            const result = (await mutate("POST", cp("/purchases/drafts"), draftBody(input))) as {
                location?: unknown;
            };
            const draftId = idFromLocation(result?.location);
            if (draftId === undefined) {
                throw new Error(
                    "DRAFT_ID_UNKNOWN: Fiken created the draft but returned no id; find it with fiken_list_purchase_drafts",
                );
            }
            doc = await updateDocument(id, { draftId, draftedAt: new Date().toISOString() });
            await audit({ ...base, event: "draft_created", ok: true, inboxDocumentId, draftId });
        } catch (e) {
            await audit({
                ...base,
                event: "draft_created",
                ok: false,
                inboxDocumentId,
                error: message(e),
            });
            return err(message(e));
        }
    }
    const draftId = doc.draftId as number;

    try {
        await uploadMultipart(
            cp(`/purchases/drafts/${draftId}/attachments`),
            { inboxDocumentId },
            new FormData(),
        );
        doc = await updateDocument(id, { attachedAt: new Date().toISOString() });
        await audit({ ...base, event: "attached", ok: true, inboxDocumentId, draftId });
    } catch (e) {
        await audit({
            ...base,
            event: "attached",
            ok: false,
            inboxDocumentId,
            draftId,
            error: message(e),
        });
        return err(
            `Draft ${draftId} was created but attaching the document failed (${message(e)}). ` +
                "Call this tool again with the same input to retry the attachment only.",
        );
    }

    return ok({ ...doc, paperlessDocumentId: id, alreadyDrafted: false });
}

export function register(server: McpServer) {
    server.registerTool(
        TOOL,
        {
            annotations: { readOnlyHint: false, idempotentHint: true },
            description:
                "Creates a purchase draft in Fiken from a Paperless document: uploads the original to the Fiken inbox, " +
                "creates the draft and attaches the document. Safe to call again with the same paperlessDocumentId: " +
                "it resumes where it stopped and never creates a second draft. Amounts are in øre. Never finalises the purchase.",
            inputSchema: draftInput,
        },
        async (input) => withStateLock(() => createDraft(input as DraftInput)),
    );

    server.registerTool(
        "fiken_get_paperless_import_status",
        {
            annotations: { readOnlyHint: true },
            description:
                "Shows what has been created in Fiken for a Paperless document (inbox document, draft, attachment).",
            inputSchema: z.object({ paperlessDocumentId: z.number().int().positive() }),
        },
        async ({ paperlessDocumentId }) => {
            try {
                return ok({ paperlessDocumentId, ...(await getDocument(paperlessDocumentId)) });
            } catch (e) {
                return err(message(e));
            }
        },
    );
}

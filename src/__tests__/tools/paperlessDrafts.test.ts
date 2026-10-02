import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../client.js", () => ({
    get: vi.fn(),
    mutate: vi.fn(),
    uploadMultipart: vi.fn(),
    cp: vi.fn((path: string) => `/companies/test-slug${path}`),
    slug: vi.fn(() => "test-slug"),
}));
vi.mock("../../paperless.js", () => ({ fetchForFiken: vi.fn() }));

import { mutate, uploadMultipart } from "../../client.js";
import { fetchForFiken } from "../../paperless.js";
import { draftInput, idFromLocation, register } from "../../tools/paperlessDrafts.js";
import { createMockServer } from "../helpers.js";

const mockMutate = vi.mocked(mutate);
const mockUpload = vi.mocked(uploadMultipart);
const mockFetchForFiken = vi.mocked(fetchForFiken);
const server = createMockServer();
const TOOL = "fiken_create_purchase_draft_from_paperless";

const input = {
    paperlessDocumentId: 42,
    invoiceIssueDate: "2026-09-28",
    cash: true,
    paid: true,
    currency: "NOK",
    totalGross: 49900,
    lines: [{ text: "Fiskesluk", account: "6540", vatType: "HIGH", net: 39920, gross: 49900 }],
};

let dir: string;
const call = (over: Record<string, unknown> = {}) => server.getHandler(TOOL)({ ...input, ...over });
const auditLines = async () =>
    (await readFile(join(dir, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

function happyFiken() {
    mockFetchForFiken.mockResolvedValue({
        bytes: Buffer.from("pdf"),
        contentType: "application/pdf",
        filename: "kvittering.pdf",
    });
    mockUpload.mockImplementation(async (path: string) =>
        path.endsWith("/inbox")
            ? {
                  created: true,
                  location: "https://api.fiken.no/api/v2/companies/test-slug/inbox/901",
              }
            : { created: true, location: null },
    );
    mockMutate.mockResolvedValue({
        created: true,
        location: "https://api.fiken.no/api/v2/companies/test-slug/purchases/drafts/555",
    });
}

beforeAll(() => {
    register(server);
});

beforeEach(async () => {
    vi.clearAllMocks();
    mockUpload.mockReset();
    mockMutate.mockReset();
    mockFetchForFiken.mockReset();
    dir = await mkdtemp(join(tmpdir(), "fiken-drafts-"));
    process.env.FIKEN_DATA_DIR = dir;
});

afterEach(async () => {
    delete process.env.FIKEN_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
});

describe(TOOL, () => {
    it("imports to the inbox, creates the draft and attaches the document", async () => {
        happyFiken();
        const result = await call();
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toMatchObject({
            paperlessDocumentId: 42,
            inboxDocumentId: 901,
            draftId: 555,
            alreadyDrafted: false,
        });

        const [inboxPath, inboxParams, form] = mockUpload.mock.calls[0];
        expect(inboxPath).toBe("/companies/test-slug/inbox");
        expect(inboxParams).toBeUndefined();
        expect((form as FormData).get("filename")).toBe("kvittering.pdf");
        expect((form as FormData).get("description")).toBe("Paperless #42");
        expect((form as FormData).get("file")).toBeInstanceOf(Blob);

        expect(mockMutate).toHaveBeenCalledWith("POST", "/companies/test-slug/purchases/drafts", {
            invoiceIssueDate: "2026-09-28",
            cash: true,
            paid: true,
            currency: "NOK",
            dueDate: undefined,
            invoiceNumber: undefined,
            contactId: undefined,
            projectId: undefined,
            kid: undefined,
            payments: undefined,
            lines: [
                {
                    text: "Fiskesluk",
                    vatType: "HIGH",
                    incomeAccount: "6540",
                    net: 39920,
                    gross: 49900,
                    projectId: undefined,
                },
            ],
        });
        expect(mockUpload.mock.calls[1].slice(0, 2)).toEqual([
            "/companies/test-slug/purchases/drafts/555/attachments",
            { inboxDocumentId: 901 },
        ]);
        expect((await auditLines()).map((l) => [l.event, l.ok])).toEqual([
            ["inbox_import", true],
            ["draft_created", true],
            ["attached", true],
        ]);
    });

    it("returns the existing draft on a repeat call without touching Fiken", async () => {
        happyFiken();
        await call();
        vi.clearAllMocks();
        const again = await call();
        expect(JSON.parse(again.content[0].text)).toMatchObject({
            draftId: 555,
            alreadyDrafted: true,
        });
        expect(mockUpload).not.toHaveBeenCalled();
        expect(mockMutate).not.toHaveBeenCalled();
        expect(mockFetchForFiken).not.toHaveBeenCalled();
    });

    it("reports a failed inbox import and imports again on retry", async () => {
        mockFetchForFiken.mockRejectedValueOnce(new Error("PAPERLESS_NOT_FOUND: gone"));
        const failed = await call();
        expect(failed.isError).toBe(true);
        expect(failed.content[0].text).toBe("Error: PAPERLESS_NOT_FOUND: gone");
        expect(mockMutate).not.toHaveBeenCalled();
        expect((await auditLines())[0]).toMatchObject({
            event: "inbox_import",
            ok: false,
            error: "PAPERLESS_NOT_FOUND: gone",
        });

        happyFiken();
        expect((await call()).isError).toBeUndefined();
    });

    it("fails clearly when Fiken returns no inbox id", async () => {
        happyFiken();
        mockUpload.mockResolvedValueOnce({ created: true, location: null });
        expect((await call()).content[0].text).toContain("INBOX_ID_UNKNOWN");
        mockUpload.mockResolvedValueOnce(null);
        expect((await call()).content[0].text).toContain("INBOX_ID_UNKNOWN");
    });

    it("needs confirmRetry after a draft attempt failed, and does not re-import", async () => {
        happyFiken();
        mockMutate.mockRejectedValueOnce(
            new Error("Fiken request failed (reset). A write may have completed"),
        );
        const failed = await call();
        expect(failed.content[0].text).toContain("A write may have completed");

        const blocked = await call();
        expect(blocked.content[0].text).toContain("RETRY_NEEDS_CONFIRMATION");
        expect(mockMutate).toHaveBeenCalledOnce();

        const retried = await call({ confirmRetry: true });
        expect(JSON.parse(retried.content[0].text)).toMatchObject({
            inboxDocumentId: 901,
            draftId: 555,
        });
        expect(mockFetchForFiken).toHaveBeenCalledOnce();
        expect(mockUpload.mock.calls.filter(([p]) => String(p).endsWith("/inbox"))).toHaveLength(1);
    });

    it("fails clearly when Fiken returns no draft id", async () => {
        happyFiken();
        mockMutate.mockResolvedValueOnce({ created: true, location: null });
        expect((await call()).content[0].text).toContain("DRAFT_ID_UNKNOWN");
        mockMutate.mockResolvedValueOnce(undefined);
        expect((await call({ confirmRetry: true })).content[0].text).toContain("DRAFT_ID_UNKNOWN");
    });

    it("retries only the attachment when attaching failed", async () => {
        happyFiken();
        mockUpload
            .mockResolvedValueOnce({ created: true, location: "/companies/test-slug/inbox/901" })
            .mockRejectedValueOnce("Fiken 500: oops");
        const failed = await call();
        expect(failed.isError).toBe(true);
        expect(failed.content[0].text).toContain(
            "Draft 555 was created but attaching the document failed (Fiken 500: oops)",
        );

        mockUpload.mockResolvedValueOnce({ created: true, location: null });
        const retried = await call();
        expect(JSON.parse(retried.content[0].text)).toMatchObject({
            draftId: 555,
            alreadyDrafted: false,
        });
        expect(mockMutate).toHaveBeenCalledOnce();
        expect(mockUpload.mock.calls.at(-1)?.[0]).toBe(
            "/companies/test-slug/purchases/drafts/555/attachments",
        );
    });
});

describe(`${TOOL} cross-field validation`, () => {
    it("rejects lines that do not add up to the total, before touching Fiken", async () => {
        happyFiken();
        const result = await call({ totalGross: 59900 });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("INVALID_INPUT");
        expect(result.content[0].text).toContain(
            "totalGross: lines add up to 49900 øre but the receipt total is 59900 øre",
        );
        expect(mockFetchForFiken).not.toHaveBeenCalled();
        expect(mockUpload).not.toHaveBeenCalled();
        expect(mockMutate).not.toHaveBeenCalled();
    });

    it("names the line whose VAT does not add up", async () => {
        const result = await call({
            lines: [{ ...input.lines[0], net: 49900 }],
        });
        expect(result.content[0].text).toContain("lines.0.gross: gross 49900 does not match");
    });
});

describe("fiken_get_paperless_import_status", () => {
    it("shows what exists for a document", async () => {
        happyFiken();
        await call();
        const status = await server.getHandler("fiken_get_paperless_import_status")({
            paperlessDocumentId: 42,
        });
        expect(JSON.parse(status.content[0].text)).toMatchObject({
            paperlessDocumentId: 42,
            inboxDocumentId: 901,
            draftId: 555,
        });
        const none = await server.getHandler("fiken_get_paperless_import_status")({
            paperlessDocumentId: 1,
        });
        expect(JSON.parse(none.content[0].text)).toEqual({ paperlessDocumentId: 1 });
    });

    it("reports a broken state file as an error", async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "state.json"), "{not json");
        const status = await server.getHandler("fiken_get_paperless_import_status")({
            paperlessDocumentId: 1,
        });
        expect(status.isError).toBe(true);
    });
});

describe("draftInput schema", () => {
    it("defaults the currency to NOK", () => {
        const { currency, ...rest } = input;
        expect(draftInput.parse(rest).currency).toBe("NOK");
        expect(currency).toBe("NOK");
    });

    it("rejects bad dates, amounts, KID, currency and totals", () => {
        const bad: Record<string, unknown>[] = [
            { invoiceIssueDate: "28.09.2026" },
            { totalGross: 499.5 },
            { kid: "1" },
            { currency: "nok" },
            { totalGross: 59900 },
            { lines: [] },
            { paperlessDocumentId: 0 },
            { payments: [{ date: "2026-09-28", account: "bank", amount: 49900 }] },
        ];
        for (const over of bad)
            expect(draftInput.safeParse({ ...input, ...over }).success).toBe(false);
        expect(
            draftInput.safeParse({
                ...input,
                kid: "1234567",
                payments: [{ date: "2026-09-28", account: "1920:10001", amount: 49900 }],
            }).success,
        ).toBe(true);
    });
});

describe("idFromLocation", () => {
    it("reads the trailing numeric id", () => {
        expect(idFromLocation("https://x/inbox/901")).toBe(901);
        expect(idFromLocation("/drafts/555/")).toBe(555);
        expect(idFromLocation("/drafts/abc")).toBeUndefined();
        expect(idFromLocation(null)).toBeUndefined();
    });
});

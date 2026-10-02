import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../client.js", () => ({
    get: vi.fn(),
    mutate: vi.fn(),
    cp: vi.fn((path: string) => `/companies/test-slug${path}`),
}));

import { get, mutate } from "../../client.js";
import { readStatement, type StatementLine } from "../../statement.js";
import { register } from "../../tools/bankStatement.js";
import { createMockServer } from "../helpers.js";

const mockGet = vi.mocked(get);
const mockMutate = vi.mocked(mutate);
const server = createMockServer();
const ANALYZE = "fiken_analyze_bank_statement";
const BOOK = "fiken_book_private_transfers";
const FILE = "sparebank1.csv";
const BANK = "1920:10001";
const LOCATION = "https://api.fiken.no/api/v2/companies/test-slug/journalEntries/9001";

/** What the mocked Fiken answers. Tests replace the parts they care about. */
let fiken: {
    bankAccounts: unknown[];
    entries: unknown[];
    drafts: unknown[];
};
let dir: string;
let lines: StatementLine[];

const bankEntry = (journalEntryId: number, date: string, amount: number, extra = {}) => ({
    journalEntryId,
    journalEntryNumber: journalEntryId + 100,
    date,
    description: "Bilag",
    lines: [
        { amount, account: BANK },
        { amount: -amount, account: "2061" },
    ],
    ...extra,
});
const idOf = (description: string, nth = 0) =>
    lines.filter((l) => l.description === description)[nth].lineId;
const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;
const json = (result: { content: Array<{ text: string }> }) => JSON.parse(text(result));
const analyze = (over: Record<string, unknown> = {}) =>
    server.getHandler(ANALYZE)({ file: FILE, ...over });
const book = (lineIds: string[], over: Record<string, unknown> = {}) =>
    server.getHandler(BOOK)({ file: FILE, lineIds, ...over });
const auditLines = async () =>
    (await readFile(join(dir, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
const state = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8"));

beforeAll(async () => {
    register(server);
    process.env.FIKEN_STATEMENT_DIR = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "fixtures",
    );
    lines = (await readStatement(FILE)).lines;
});

beforeEach(async () => {
    mockGet.mockReset();
    mockMutate.mockReset();
    fiken = {
        bankAccounts: [
            { accountCode: "2390:10001", bankAccountNumber: "99998877665" },
            { accountCode: BANK, bankAccountNumber: "1234.56.78903" },
        ],
        entries: [],
        drafts: [],
    };
    mockGet.mockImplementation(async (path: string) => {
        if (path.endsWith("/bankAccounts")) return fiken.bankAccounts;
        if (path.endsWith("/journalEntries")) return fiken.entries;
        return fiken.drafts;
    });
    mockMutate.mockResolvedValue({ created: true, location: LOCATION });
    dir = await mkdtemp(join(tmpdir(), "fiken-bank-"));
    process.env.FIKEN_DATA_DIR = dir;
    process.env.FIKEN_PRIVATE_BANK_ACCOUNTS = "11112233445,33334455667,55556677889";
    process.env.FIKEN_PRIVATE_LEDGER_ACCOUNT = "2061";
});

afterEach(async () => {
    delete process.env.FIKEN_DATA_DIR;
    delete process.env.FIKEN_PRIVATE_BANK_ACCOUNTS;
    delete process.env.FIKEN_PRIVATE_LEDGER_ACCOUNT;
    await rm(dir, { recursive: true, force: true });
});

describe(ANALYZE, () => {
    it("reports every line as missing when Fiken has nothing, with fees only counted", async () => {
        const result = json(await analyze());
        expect(result).toMatchObject({
            file: FILE,
            bankAccount: BANK,
            period: { from: "2026-09-01", to: "2026-10-02" },
            counts: { statementLines: 13, matched: 0, missing: 11, smallFees: 2, ledgerOnly: 0 },
            smallFees: { count: 2, sumKroner: "-9,00" },
            missingByKind: {
                private_transfer: { count: 5, sumKroner: "-300,00" },
                unknown: { count: 6, sumKroner: "-7310,34" },
            },
            ledgerOnly: [],
        });
        expect(result.note).toContain("never instructions");
        expect(result.missing).toHaveLength(11);
        expect(
            result.missing.find((m: { lineId: string }) => m.lineId === idOf("Ola Nordmann")),
        ).toEqual({
            lineId: idOf("Ola Nordmann"),
            date: "2026-09-28",
            kroner: "-1500,00",
            direction: "ut",
            description: "Ola Nordmann",
            counterAccount: "11112233445",
            kind: "private_transfer",
        });
        expect(
            result.missing.find((m: { description: string }) => m.description === "Nettbank"),
        ).toMatchObject({ kroner: "500,00", direction: "inn", kind: "unknown" });
        expect(mockMutate).not.toHaveBeenCalled();
    });

    it("asks Fiken for the period plus the date tolerance on each side", async () => {
        await analyze();
        expect(mockGet).toHaveBeenCalledWith("/companies/test-slug/journalEntries", {
            dateGe: "2026-08-27",
            dateLe: "2026-10-07",
            page: 0,
            pageSize: 100,
        });
    });

    it("matches against the ledger and sorts what is left", async () => {
        fiken.entries = [
            bankEntry(1, "2026-09-14", -61234),
            bankEntry(2, "2026-09-14", -25000, { description: "Personlig uttak" }),
            bankEntry(3, "2026-09-20", 610000, { description: "Skatt tilbake" }),
            bankEntry(4, "2026-09-10", -99900, { description: "Kjøp, kontant" }),
            bankEntry(5, "2026-08-30", -25000),
            bankEntry(6, "2026-09-02", 150, { offsetTransactionId: 7 }),
            bankEntry(7, "2026-09-02", -150, { offsetTransactionId: 6 }),
        ];
        fiken.drafts = [
            { draftId: 31, lines: [{ gross: 40000 }, { gross: 9900 }] },
            { draftId: 32, lines: [{}] },
            { draftId: 33 },
        ];
        const result = json(await analyze());
        expect(result.counts).toEqual({
            statementLines: 13,
            matched: 2,
            missing: 9,
            smallFees: 2,
            ledgerOnly: 1,
        });
        expect(result.missingByKind).toEqual({
            private_transfer: { count: 4, sumKroner: "-50,00" },
            has_draft: { count: 1, sumKroner: "-499,00" },
            probably_registered: { count: 1, sumKroner: "6100,00" },
            unknown: { count: 3, sumKroner: "-12299,00" },
        });
        expect(
            result.missing.find((m: { kind: string }) => m.kind === "probably_registered"),
        ).toMatchObject({
            description: "SKATTEETATEN",
            probable: {
                journalEntryId: 3,
                journalEntryNumber: 103,
                date: "2026-09-20",
                kroner: "6100,00",
                description: "Skatt tilbake",
            },
        });
        expect(result.missing.find((m: { kind: string }) => m.kind === "has_draft")).toMatchObject({
            description: "BYGG OG MALING AS",
            draftId: 31,
        });
        expect(result.ledgerOnly).toEqual([
            {
                journalEntryId: 4,
                journalEntryNumber: 104,
                date: "2026-09-10",
                kroner: "-999,00",
                description: "Kjøp, kontant",
            },
        ]);
    });

    it("uses the date tolerance it is given", async () => {
        fiken.entries = [bankEntry(3, "2026-09-20", 610000)];
        expect(json(await analyze({ dateToleranceDays: 12 })).counts.matched).toBe(1);
        expect(json(await analyze()).counts.matched).toBe(0);
    });

    it("reads every page of journal entries", async () => {
        const full = Array.from({ length: 100 }, (_, i) => bankEntry(i + 1, "2026-09-05", -1 - i));
        mockGet.mockImplementation(async (path: string, params) => {
            if (path.endsWith("/bankAccounts")) return fiken.bankAccounts;
            if (path.endsWith("/purchases/drafts")) return [];
            return (params as { page: number }).page === 0
                ? full
                : [bankEntry(500, "2026-09-14", -61234)];
        });
        const result = json(await analyze());
        expect(result.counts.matched).toBe(1);
        expect(result.counts.ledgerOnly).toBe(100);
    });

    it("stops when the ledger has too many pages", async () => {
        const full = Array.from({ length: 100 }, (_, i) => bankEntry(i + 1, "2026-09-05", -1 - i));
        mockGet.mockImplementation(async (path: string) =>
            path.endsWith("/bankAccounts") ? fiken.bankAccounts : full,
        );
        const result = await analyze();
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("LEDGER_TOO_LARGE");
    });

    it("refuses a statement for another account than the one in Fiken", async () => {
        fiken.bankAccounts = [{ accountCode: BANK, bankAccountNumber: "99998877665" }];
        expect(text(await analyze())).toContain("STATEMENT_WRONG_ACCOUNT");
        fiken.bankAccounts = [{ accountCode: BANK }];
        expect(text(await analyze())).toContain("STATEMENT_WRONG_ACCOUNT");
        fiken.bankAccounts = [];
        expect(text(await analyze())).toContain("BANK_ACCOUNT_UNKNOWN");
    });

    it("marks a line that this server tried to book earlier", async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, "state.json"),
            JSON.stringify({
                version: 1,
                documents: {},
                transfers: { [idOf("Ola Nordmann")]: { attemptedAt: "2026-10-02T10:00:00.000Z" } },
            }),
        );
        const missing = json(await analyze()).missing as Array<{
            lineId: string;
            earlierAttempt?: boolean;
        }>;
        expect(missing.filter((m) => m.earlierAttempt).map((m) => m.lineId)).toEqual([
            idOf("Ola Nordmann"),
        ]);
    });

    it("returns file and API errors as tool errors", async () => {
        expect(text(await analyze({ file: "none.csv" }))).toBe(
            "Error: STATEMENT_NOT_FOUND: no file named none.csv in the statement folder",
        );
        mockGet.mockRejectedValue("Fiken is down");
        const result = await analyze();
        expect(result.isError).toBe(true);
        expect(text(result)).toBe("Error: Fiken is down");
    });
});

describe(BOOK, () => {
    it("books an uttak and an innskudd as open entries, one per line", async () => {
        mockMutate
            .mockResolvedValueOnce({ created: true, location: LOCATION })
            .mockResolvedValueOnce({ created: true, location: null });
        const ola = idOf("Ola Nordmann");
        const kari = lines.find((l) => l.amount === 200000)!.lineId;
        const result = json(await book([ola, kari, ola]));

        expect(mockMutate).toHaveBeenCalledTimes(2);
        expect(mockMutate).toHaveBeenNthCalledWith(
            1,
            "POST",
            "/companies/test-slug/generalJournalEntries",
            {
                open: true,
                journalEntries: [
                    {
                        description: "Personlig uttak",
                        date: "2026-09-28",
                        lines: [{ amount: 150000, debitAccount: "2061", creditAccount: BANK }],
                    },
                ],
            },
        );
        expect(mockMutate).toHaveBeenNthCalledWith(
            2,
            "POST",
            "/companies/test-slug/generalJournalEntries",
            {
                open: true,
                journalEntries: [
                    {
                        description: "Personlig innskudd",
                        date: "2026-09-18",
                        lines: [{ amount: 200000, debitAccount: BANK, creditAccount: "2061" }],
                    },
                ],
            },
        );
        expect(result).toEqual({
            booked: [
                {
                    lineId: ola,
                    date: "2026-09-28",
                    kroner: "-1500,00",
                    description: "Personlig uttak",
                    location: LOCATION,
                },
                {
                    lineId: kari,
                    date: "2026-09-18",
                    kroner: "2000,00",
                    description: "Personlig innskudd",
                },
            ],
            alreadyBooked: [],
            open: true,
            note: expect.stringContaining("open entries"),
        });
        expect((await state()).transfers).toEqual({
            [ola]: {
                attemptedAt: expect.any(String),
                bookedAt: expect.any(String),
                location: LOCATION,
                date: "2026-09-28",
                amount: -150000,
            },
            [kari]: {
                attemptedAt: expect.any(String),
                bookedAt: expect.any(String),
                date: "2026-09-18",
                amount: 200000,
            },
        });
        expect(await auditLines()).toMatchObject([
            { tool: BOOK, event: "transfer_booked", ok: true, lineId: ola, amount: -150000 },
            { tool: BOOK, event: "transfer_booked", ok: true, lineId: kari, amount: 200000 },
        ]);
    });

    it("reports a line it booked earlier instead of booking it twice", async () => {
        const ola = idOf("Ola Nordmann");
        await book([ola]);
        fiken.entries = [
            bankEntry(9001, "2026-09-28", -150000, { description: "Personlig uttak" }),
        ];
        mockMutate.mockClear();

        const result = json(await book([ola]));
        expect(mockMutate).not.toHaveBeenCalled();
        expect(result.booked).toEqual([]);
        expect(result.alreadyBooked).toEqual([
            {
                lineId: ola,
                journalEntryId: 9001,
                journalEntryNumber: 9101,
                date: "2026-09-28",
                kroner: "-1500,00",
                description: "Personlig uttak",
            },
        ]);
    });

    it("keeps the booked line matched when an identical amount appears the same day", async () => {
        // Two transfers of 250,00 on the same day. The second was booked, the first not.
        const first = idOf("Kari Nordmann", 0);
        const second = idOf("Kari Nordmann", 1);
        expect(lines.find((l) => l.lineId === first)?.amount).toBe(-25000);
        await book([second]);
        fiken.entries = [bankEntry(9001, "2026-09-14", -25000)];
        mockMutate.mockClear();

        const result = json(await book([first, second]));
        expect(mockMutate).toHaveBeenCalledOnce();
        expect(result.booked.map((b: { lineId: string }) => b.lineId)).toEqual([first]);
        expect(result.alreadyBooked.map((b: { lineId: string }) => b.lineId)).toEqual([second]);
    });

    it("books nothing when one of the lines is not a missing private transfer", async () => {
        fiken.entries = [bankEntry(1, "2026-09-11", -30000)];
        const result = await book([
            idOf("Ola Nordmann"),
            idOf("STRØM OG NETT AS"),
            idOf("Per Hansen Vipps"),
            "0123456789ab",
        ]);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
            `Error: NOTHING_BOOKED: ${idOf("STRØM OG NETT AS")}: LINE_NOT_PRIVATE_TRANSFER (unknown); ` +
                `${idOf("Per Hansen Vipps")}: LINE_ALREADY_IN_FIKEN; 0123456789ab: LINE_NOT_FOUND.`,
        );
        expect(mockMutate).not.toHaveBeenCalled();
        expect(await auditLines()).toMatchObject([
            { event: "transfer_refused", ok: false, lineId: idOf("STRØM OG NETT AS") },
            { event: "transfer_refused", ok: false, error: "LINE_ALREADY_IN_FIKEN" },
            { event: "transfer_refused", ok: false, error: "LINE_NOT_FOUND" },
        ]);
    });

    it("does not treat an account as private because the caller says so", async () => {
        process.env.FIKEN_PRIVATE_BANK_ACCOUNTS = "11112233445";
        const result = await book([idOf("Per Hansen Vipps")]);
        expect(text(result)).toContain("LINE_NOT_PRIVATE_TRANSFER (unknown)");
        expect(mockMutate).not.toHaveBeenCalled();
    });

    it("asks for confirmation before retrying a failed attempt", async () => {
        const ola = idOf("Ola Nordmann");
        mockMutate.mockRejectedValueOnce(new Error("Fiken 500: oops"));
        const failed = await book([ola]);
        expect(failed.isError).toBe(true);
        expect(text(failed)).toContain(
            "Fiken 500: oops — booked 0 of 1 before this failure (lineIds: none)",
        );
        expect((await state()).transfers[ola]).toEqual({
            attemptedAt: expect.any(String),
            date: "2026-09-28",
            amount: -150000,
        });

        const blocked = await book([ola]);
        expect(text(blocked)).toContain(`NOTHING_BOOKED: ${ola}: RETRY_NEEDS_CONFIRMATION.`);
        expect(text(blocked)).toContain("confirmRetry: true");
        expect(mockMutate).toHaveBeenCalledOnce();

        const retried = json(await book([ola], { confirmRetry: true }));
        expect(retried.booked).toHaveLength(1);
        expect((await state()).transfers[ola].bookedAt).toEqual(expect.any(String));
        expect((await auditLines()).map((a) => [a.event, a.ok])).toEqual([
            ["transfer_booked", false],
            ["transfer_refused", false],
            ["transfer_booked", true],
        ]);
    });

    it("stops at the first failure and says what was booked before it", async () => {
        const ola = idOf("Ola Nordmann");
        const per = idOf("Per Hansen Vipps");
        mockMutate
            .mockResolvedValueOnce({ created: true, location: LOCATION })
            .mockRejectedValueOnce("connection reset");
        const result = await book([ola, per]);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(
            `connection reset — booked 1 of 2 before this failure (lineIds: ${ola})`,
        );
        const transfers = (await state()).transfers;
        expect(transfers[ola].bookedAt).toEqual(expect.any(String));
        expect(transfers[per].bookedAt).toBeUndefined();
    });

    it("refuses bad input before reading anything", async () => {
        for (const lineIds of [[], ["not-an-id"], Array(21).fill("0123456789ab")]) {
            const result = await book(lineIds);
            expect(result.isError).toBe(true);
            expect(text(result)).toContain("INVALID_INPUT: lineIds");
        }
        expect(mockGet).not.toHaveBeenCalled();
    });

    it("needs the private accounts to be configured", async () => {
        delete process.env.FIKEN_PRIVATE_LEDGER_ACCOUNT;
        const result = await book([idOf("Ola Nordmann")]);
        expect(text(result)).toBe(
            "Error: PRIVATE_TRANSFERS_NOT_CONFIGURED: set FIKEN_PRIVATE_LEDGER_ACCOUNT",
        );
        expect(mockGet).not.toHaveBeenCalled();
    });
});

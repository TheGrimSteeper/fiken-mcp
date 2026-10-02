import { describe, it, expect } from "vitest";
import { ledgerLines, reconcile, type LedgerLine, type ReconcileOptions } from "../reconcile.js";
import type { StatementLine } from "../statement.js";

const BANK = "1920:10001";
const PRIVATE = "11112233445";

let nextId = 0;
const line = (date: string, amount: number, over: Partial<StatementLine> = {}): StatementLine => ({
    lineId: `line${++nextId}`,
    date,
    amount,
    description: "tekst",
    ...over,
});
const entry = (date: string, amount: number, journalEntryId = ++nextId): LedgerLine => ({
    journalEntryId,
    date,
    amount,
    description: "bilag",
});
const options = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
    dateToleranceDays: 5,
    privateBankAccounts: new Set([PRIVATE]),
    drafts: [],
    ...over,
});

describe("ledgerLines", () => {
    it("returns the lines on the bank account", () => {
        const entries = [
            {
                journalEntryId: 1,
                journalEntryNumber: 116,
                date: "2026-09-01",
                description: "Personlig uttak",
                lines: [
                    { amount: 100000, account: "2061" },
                    { amount: -100000, account: BANK },
                ],
            },
            { journalEntryId: 2, date: "2026-09-02", lines: [{ amount: 500, account: BANK }] },
            {
                journalEntryId: 3,
                date: "2026-09-03",
                lines: [{ amount: 500, account: "1500:10001" }],
            },
        ];
        expect(ledgerLines(entries, BANK)).toEqual([
            {
                journalEntryId: 1,
                journalEntryNumber: 116,
                date: "2026-09-01",
                amount: -100000,
                description: "Personlig uttak",
            },
            {
                journalEntryId: 2,
                journalEntryNumber: undefined,
                date: "2026-09-02",
                amount: 500,
                description: "",
            },
        ]);
    });

    it("leaves out a cancelled entry and its counter-entry", () => {
        const entries = [
            {
                journalEntryId: 1,
                date: "2026-07-31",
                description: "Renter",
                offsetTransactionId: 20,
                lines: [{ amount: 150, account: BANK }],
            },
            {
                journalEntryId: 2,
                date: "2026-07-31",
                description: "Motlinje for: 'Renter'",
                offsetTransactionId: 10,
                lines: [{ amount: -150, account: BANK }],
            },
        ];
        expect(ledgerLines(entries, BANK)).toEqual([]);
    });
});

describe("reconcile", () => {
    it("matches the same amount within the date tolerance", () => {
        const a = line("2026-08-31", -160000);
        const b = line("2026-09-10", -30000);
        const ledger = [entry("2026-08-29", -160000), entry("2026-09-16", -30000)];
        const result = reconcile([a, b], ledger, options());
        expect(result.matched).toEqual([{ line: a, ledger: ledger[0] }]);
        expect(result.unmatched.map((u) => u.lineId)).toEqual([b.lineId]);
    });

    it("pairs the closest dates first, one ledger line per statement line", () => {
        const first = line("2026-09-01", -50000);
        const second = line("2026-09-04", -50000);
        const third = line("2026-09-04", -50000);
        const ledger = [entry("2026-09-04", -50000), entry("2026-09-02", -50000)];
        const result = reconcile([first, second, third], ledger, options());
        expect(result.matched).toEqual([
            { line: second, ledger: ledger[0] },
            { line: first, ledger: ledger[1] },
        ]);
        expect(result.unmatched.map((u) => u.lineId)).toEqual([third.lineId]);
        expect(result.ledgerOnly).toEqual([]);
    });

    it("takes the first ledger line when two are equally close", () => {
        const a = line("2026-09-04", -50000);
        const ledger = [entry("2026-09-06", -50000), entry("2026-09-02", -50000)];
        const result = reconcile([a], ledger, options());
        expect(result.matched).toEqual([{ line: a, ledger: ledger[0] }]);
        expect(result.ledgerOnly).toEqual([]);
    });

    it("lets a preferred line win a tie", () => {
        const a = line("2026-09-04", -50000);
        const b = line("2026-09-04", -50000);
        const ledger = [entry("2026-09-04", -50000)];
        const preferred = new Set([b.lineId]);
        expect(reconcile([a, b], ledger, options({ preferred })).matched[0].line).toBe(b);
        expect(reconcile([a, b], ledger, options()).matched[0].line).toBe(a);
    });

    it("marks the same amount on a date further away as probably registered", () => {
        const a = line("2026-09-08", 610000, { counterAccount: PRIVATE });
        const last = line("2026-09-30", -100000);
        const ledger = [entry("2026-09-20", 610000), entry("2026-11-20", 610000)];
        const result = reconcile([a, last], ledger, options());
        expect(result.matched).toEqual([]);
        expect(result.unmatched[0]).toEqual({
            ...a,
            kind: "probably_registered",
            probable: ledger[0],
        });
        expect(result.ledgerOnly).toEqual([]);
    });

    it("does not pair a line with last month's entry of the same amount", () => {
        const a = line("2026-09-08", -150000, { counterAccount: PRIVATE });
        const last = line("2026-09-30", -100000);
        const result = reconcile([a, last], [entry("2026-08-25", -150000)], options());
        expect(result.unmatched[0]).toEqual({ ...a, kind: "private_transfer" });
        expect(result.ledgerOnly).toEqual([]);
    });

    it("recognises private transfers by the counter-account, in both directions", () => {
        const result = reconcile(
            [
                line("2026-09-10", -120000, { counterAccount: PRIVATE }),
                line("2026-09-18", 200000, { counterAccount: PRIVATE }),
                line("2026-09-19", -50000, { counterAccount: "99998877665" }),
            ],
            [],
            options(),
        );
        expect(result.unmatched.map((u) => u.kind)).toEqual([
            "private_transfer",
            "private_transfer",
            "unknown",
        ]);
    });

    it("counts small outgoing lines without a counter-account as fees", () => {
        const result = reconcile(
            [
                line("2026-09-30", -600),
                line("2026-09-30", -1000),
                line("2026-09-30", -1001),
                line("2026-09-30", 600),
                line("2026-09-30", -600, { counterAccount: "99998877665" }),
            ],
            [],
            options(),
        );
        expect(result.unmatched.map((u) => u.kind)).toEqual([
            "small_fee",
            "small_fee",
            "unknown",
            "unknown",
            "unknown",
        ]);
    });

    it("points to a purchase draft with the same total, each draft once", () => {
        const result = reconcile(
            [line("2026-09-01", -49900), line("2026-09-02", -49900), line("2026-09-03", 49900)],
            [],
            options({ drafts: [{ draftId: 7, gross: 49900 }] }),
        );
        expect(result.unmatched.map((u) => [u.kind, u.draftId])).toEqual([
            ["has_draft", 7],
            ["unknown", undefined],
            ["unknown", undefined],
        ]);
    });

    it("lists ledger lines in the statement period that have no statement line", () => {
        const inside = entry("2026-09-11", -99900);
        const ledger = [entry("2026-08-25", -100), inside, entry("2026-10-05", -200)];
        const result = reconcile(
            [line("2026-09-01", -1), line("2026-09-30", -2)],
            ledger,
            options(),
        );
        expect(result.ledgerOnly).toEqual([inside]);
    });

    it("handles a statement without lines", () => {
        expect(reconcile([], [entry("2026-09-11", -100)], options())).toEqual({
            matched: [],
            unmatched: [],
            ledgerOnly: [],
        });
    });
});

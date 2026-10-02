import type { StatementLine } from "./statement.js";

/**
 * Matches bank statement lines against the ledger lines on the bank account and
 * sorts what is left into kinds. Pure: no file or network access.
 */

/** Outgoing lines up to this size with no counter-account are the bank's own fees. */
export const SMALL_FEE_MAX_ORE = 1000;
/** How far apart, inside the statement period, a statement line and a ledger line of the same amount may be and still be shown as a likely pair. */
export const PROBABLE_DAYS = 31;

export interface LedgerLine {
    journalEntryId: number;
    journalEntryNumber?: number;
    date: string;
    /** Øre. Positive is money into the bank account. */
    amount: number;
    description: string;
}

export interface Draft {
    draftId: number;
    /** Total in øre including VAT. */
    gross: number;
}

export type Kind =
    | "private_transfer"
    | "small_fee"
    | "has_draft"
    | "probably_registered"
    | "unknown";

export interface UnmatchedLine extends StatementLine {
    kind: Kind;
    /** probably_registered: the ledger line with the same amount and another date. */
    probable?: LedgerLine;
    /** has_draft: the purchase draft with the same total. */
    draftId?: number;
}

export interface ReconcileOptions {
    dateToleranceDays: number;
    privateBankAccounts: ReadonlySet<string>;
    drafts: Draft[];
    /** Line ids that win a tie, e.g. lines this server booked earlier. */
    preferred?: ReadonlySet<string>;
}

export interface Reconciliation {
    matched: Array<{ line: StatementLine; ledger: LedgerLine }>;
    unmatched: UnmatchedLine[];
    /** Ledger lines dated inside the statement period that no statement line accounts for. */
    ledgerOnly: LedgerLine[];
}

interface JournalEntry {
    journalEntryId: number;
    journalEntryNumber?: number;
    date: string;
    description?: string;
    offsetTransactionId?: number;
    lines: Array<{ amount: number; account: string }>;
}

/**
 * The lines posted on `bankAccount` in entries from GET /journalEntries. A cancelled
 * entry and its counter-entry both carry offsetTransactionId and are left out.
 */
export function ledgerLines(entries: unknown[], bankAccount: string): LedgerLine[] {
    return (entries as JournalEntry[])
        .filter((entry) => entry.offsetTransactionId == null)
        .flatMap((entry) =>
            entry.lines
                .filter((line) => line.account === bankAccount)
                .map((line) => ({
                    journalEntryId: entry.journalEntryId,
                    journalEntryNumber: entry.journalEntryNumber,
                    date: entry.date,
                    amount: line.amount,
                    description: entry.description ?? "",
                })),
        );
}

function daysBetween(a: string, b: string): number {
    return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * One-to-one pairs of the same amount at most `maxDays` apart, closest dates first.
 * Returns statement index → ledger index.
 */
function pair(
    lines: StatementLine[],
    ledger: LedgerLine[],
    maxDays: number,
    preferred: ReadonlySet<string>,
): Map<number, number> {
    const candidates: Array<{ s: number; l: number; days: number; rank: number }> = [];
    lines.forEach((line, s) => {
        ledger.forEach((entry, l) => {
            if (entry.amount !== line.amount) return;
            const days = daysBetween(line.date, entry.date);
            if (days <= maxDays) {
                candidates.push({ s, l, days, rank: preferred.has(line.lineId) ? 0 : 1 });
            }
        });
    });
    candidates.sort((a, b) => a.days - b.days || a.rank - b.rank || a.s - b.s || a.l - b.l);
    const pairs = new Map<number, number>();
    const taken = new Set<number>();
    for (const c of candidates) {
        if (pairs.has(c.s) || taken.has(c.l)) continue;
        pairs.set(c.s, c.l);
        taken.add(c.l);
    }
    return pairs;
}

export function reconcile(
    lines: StatementLine[],
    ledger: LedgerLine[],
    options: ReconcileOptions,
): Reconciliation {
    const preferred = options.preferred ?? new Set<string>();
    const exact = pair(lines, ledger, options.dateToleranceDays, preferred);
    const usedLedger = new Set(exact.values());

    // Lines are oldest first, so the first and last dates are the period. A ledger
    // line dated outside it belongs to a statement line that is not in this file,
    // e.g. last month's payment of the same amount, so it is left out from here on.
    const from = lines[0]?.date ?? "";
    const to = lines[lines.length - 1]?.date ?? "";
    const leftLines = lines.filter((_, s) => !exact.has(s));
    const leftLedger = ledger.filter(
        (entry, l) => !usedLedger.has(l) && entry.date >= from && entry.date <= to,
    );
    const probable = pair(leftLines, leftLedger, PROBABLE_DAYS, preferred);
    const probableLedger = new Set(probable.values());

    const freeDrafts = [...options.drafts];
    const unmatched = leftLines.map((line, i): UnmatchedLine => {
        const likely = probable.get(i);
        if (likely !== undefined) {
            return { ...line, kind: "probably_registered", probable: leftLedger[likely] };
        }
        if (line.counterAccount && options.privateBankAccounts.has(line.counterAccount)) {
            return { ...line, kind: "private_transfer" };
        }
        if (line.amount < 0 && line.amount >= -SMALL_FEE_MAX_ORE && !line.counterAccount) {
            return { ...line, kind: "small_fee" };
        }
        const d = freeDrafts.findIndex((draft) => draft.gross === -line.amount);
        if (d >= 0) {
            const [draft] = freeDrafts.splice(d, 1);
            return { ...line, kind: "has_draft", draftId: draft.draftId };
        }
        return { ...line, kind: "unknown" };
    });

    return {
        matched: [...exact].map(([s, l]) => ({ line: lines[s], ledger: ledger[l] })),
        unmatched,
        ledgerOnly: leftLedger.filter((_, l) => !probableLedger.has(l)),
    };
}

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { accountNumber } from "./bankConfig.js";
import { isoDate } from "./validation.js";

/**
 * Reads a bank statement exported as CSV from SpareBank 1 (nettbank, "Eksporter"):
 * semicolon-separated, quoted fields, dd.mm.yyyy dates, comma decimals, UTF-8 with
 * a byte-order mark (older exports are Latin-1). Amounts are turned into øre with
 * integer arithmetic.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const COLUMNS = ["Dato", "Beskrivelse", "Inn", "Ut", "Til konto", "Fra konto"] as const;
type Column = (typeof COLUMNS)[number];

export interface StatementLine {
    /** Stable id of the line: the same line gets the same id in every export. */
    lineId: string;
    date: string;
    /** Øre. Positive is money into the account. */
    amount: number;
    description: string;
    counterAccount?: string;
}

export interface Statement {
    /** The account the statement belongs to, digits only. */
    account: string;
    from: string;
    to: string;
    /** Oldest first. */
    lines: StatementLine[];
}

export function statementDir(): string {
    return process.env.FIKEN_STATEMENT_DIR || "/statements";
}

/** "-1234,50" for -123450 øre. */
export function kroner(ore: number): string {
    const abs = Math.abs(ore);
    const whole = Math.floor(abs / 100);
    return `${ore < 0 ? "-" : ""}${whole},${String(abs % 100).padStart(2, "0")}`;
}

/** UTF-8 when the bytes are valid UTF-8 (the byte-order mark is dropped), otherwise Latin-1. */
export function decode(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return Buffer.from(bytes).toString("latin1");
    }
}

/** Rows of fields from semicolon-separated text. A quoted field may hold ";" and doubled quotes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c !== '"') field += c;
            else if (text[i + 1] === '"') {
                field += '"';
                i++;
            } else quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === ";") {
            row.push(field);
            field = "";
        } else if (c === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (c !== "\r") field += c;
    }
    row.push(field);
    rows.push(row);
    return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function toIsoDate(raw: string): string | undefined {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
    const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : "";
    return isoDate.safeParse(iso).success ? iso : undefined;
}

/** The absolute amount in øre. Only the "Ut" column may carry a minus sign. */
function toOre(raw: string, allowMinus: boolean): number | undefined {
    const m = /^(-?)(\d+)(?:,(\d{1,2}))?$/.exec(raw.replace(/\s/g, ""));
    if (!m || (m[1] === "-" && !allowMinus)) return undefined;
    return Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
}

type Row = Omit<StatementLine, "lineId"> & { account: string };

function parseRow(row: string[], column: Record<Column, number>, lineNumber: number): Row {
    const cell = (name: Column) => (row[column[name]] ?? "").trim();
    const fail = (why: string) => new Error(`STATEMENT_LINE_INVALID: line ${lineNumber}: ${why}`);

    const date = toIsoDate(cell("Dato"));
    if (!date) throw fail("the date is not a real date written dd.mm.yyyy");
    const moneyIn = cell("Inn");
    const moneyOut = cell("Ut");
    if ((moneyIn === "") === (moneyOut === "")) {
        throw fail("exactly one of Inn and Ut must hold an amount");
    }
    const incoming = moneyIn !== "";
    const ore = incoming ? toOre(moneyIn, false) : toOre(moneyOut, true);
    if (!ore) throw fail("the amount is not a number such as 1234,50");
    const own = accountNumber(cell(incoming ? "Til konto" : "Fra konto"));
    if (own === "") throw fail("the statement's own account number is missing");
    const counter = accountNumber(cell(incoming ? "Fra konto" : "Til konto"));
    return {
        date,
        amount: incoming ? ore : -ore,
        description: cell("Beskrivelse"),
        counterAccount: counter === "" ? undefined : counter,
        account: own,
    };
}

/**
 * Parse the text of an export. Lines come back oldest first. A line's id is a hash
 * of its date, amount, text, counter-account and its number among identical lines,
 * so it does not depend on which period was exported.
 */
export function parseStatement(text: string): Statement {
    const [header = [], ...rows] = parseCsv(text);
    const names = header.map((name) => name.trim());
    const column = Object.fromEntries(COLUMNS.map((name) => [name, names.indexOf(name)])) as Record<
        Column,
        number
    >;
    const missing = COLUMNS.filter((name) => column[name] < 0);
    if (missing.length > 0) {
        throw new Error(
            `STATEMENT_FORMAT_UNKNOWN: expected a SpareBank 1 CSV export with the columns ${COLUMNS.join(", ")}; missing: ${missing.join(", ")}`,
        );
    }
    if (rows.length === 0) throw new Error("STATEMENT_EMPTY: the file has no statement lines");

    const parsed = rows.map((row, i) => parseRow(row, column, i + 2));
    const account = parsed[0].account;
    if (parsed.some((row) => row.account !== account)) {
        throw new Error(
            "STATEMENT_SEVERAL_ACCOUNTS: the file has lines from more than one account; export one account at a time",
        );
    }
    // Stable, so lines of the same day keep their order from the file.
    parsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const seen = new Map<string, number>();
    const lines = parsed.map(({ account: _own, ...line }) => {
        const key = [line.date, line.amount, line.description, line.counterAccount ?? ""].join("|");
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        const lineId = createHash("sha256").update(`${key}|${occurrence}`).digest("hex");
        return { lineId: lineId.slice(0, 12), ...line };
    });
    return { account, from: lines[0].date, to: lines[lines.length - 1].date, lines };
}

/** Read `file` from the statement folder. Only a plain file name is accepted. */
export async function readStatement(file: string): Promise<Statement> {
    if (file !== basename(file) || file.includes("\\") || !/^[^.].*\.csv$/i.test(file)) {
        throw new Error(
            "STATEMENT_FILE_INVALID: give the name of a .csv file in the statement folder, without a path",
        );
    }
    const path = join(statementDir(), file);
    let size: number;
    try {
        const info = await lstat(path);
        if (!info.isFile())
            throw Object.assign(new Error("not a regular file"), { code: "ENOENT" });
        size = info.size;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`STATEMENT_NOT_FOUND: no file named ${file} in the statement folder`);
        }
        throw e;
    }
    if (size > MAX_BYTES) throw new Error("STATEMENT_TOO_LARGE: the file is larger than 2 MB");
    return parseStatement(decode(await readFile(path)));
}

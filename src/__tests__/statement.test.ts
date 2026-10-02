import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decode,
    kroner,
    parseCsv,
    parseStatement,
    readStatement,
    statementDir,
} from "../statement.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HEADER = "Dato;Beskrivelse;Rentedato;Inn;Ut;Til konto;Fra konto;";
const OWN = "12345678903";
const out = (date: string, text: string, amount: string, to = "") =>
    `"${date}";"${text}";;;"${amount}";"${to}";"${OWN}";`;
const into = (date: string, text: string, amount: string, from = "") =>
    `"${date}";"${text}";;"${amount}";;"${OWN}";"${from}";`;
const statement = (...rows: string[]) => parseStatement([HEADER, ...rows].join("\n"));

describe("kroner", () => {
    it("writes øre as kroner with a comma", () => {
        expect(kroner(0)).toBe("0,00");
        expect(kroner(5)).toBe("0,05");
        expect(kroner(-150)).toBe("-1,50");
        expect(kroner(-123450)).toBe("-1234,50");
        expect(kroner(12345678)).toBe("123456,78");
    });
});

describe("decode", () => {
    it("reads UTF-8 and drops the byte-order mark", () => {
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("STRØM")]);
        expect(decode(bytes)).toBe("STRØM");
    });

    it("falls back to Latin-1", () => {
        expect(decode(Buffer.from("STRØM", "latin1"))).toBe("STRØM");
    });
});

describe("parseCsv", () => {
    it("splits on semicolons and newlines, also CRLF", () => {
        expect(parseCsv("a;b\r\nc;d\n")).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
    });

    it("keeps semicolons, newlines and doubled quotes inside a quoted field", () => {
        expect(parseCsv('"a;b";"say ""hi""";"two\nlines"')).toEqual([
            ["a;b", 'say "hi"', "two\nlines"],
        ]);
    });

    it("drops empty rows", () => {
        expect(parseCsv("a\n\n;;\nb")).toEqual([["a"], ["b"]]);
        expect(parseCsv("")).toEqual([]);
    });
});

describe("parseStatement", () => {
    it("reads the SpareBank 1 export, oldest line first", async () => {
        const parsed = parseStatement(decode(await readFile(join(FIXTURES, "sparebank1.csv"))));
        expect(parsed.account).toBe(OWN);
        expect(parsed.from).toBe("2026-09-01");
        expect(parsed.to).toBe("2026-10-02");
        expect(parsed.lines).toHaveLength(13);
        expect(parsed.lines.map((l) => l.date)).toEqual(
            [...parsed.lines.map((l) => l.date)].sort(),
        );
        expect(parsed.lines[0]).toEqual({
            lineId: expect.stringMatching(/^[0-9a-f]{12}$/),
            date: "2026-09-01",
            amount: -49900,
            description: "BYGG OG MALING AS",
            counterAccount: "88889900112",
        });
        expect(parsed.lines[1].description).toBe(
            'Til: 7777 88 99001 Betaling for "hytta"; siste del',
        );
        expect(parsed.lines[1].amount).toBe(-1200000);
        expect(parsed.lines.find((l) => l.description === "STRØM OG NETT AS")?.amount).toBe(-61234);
    });

    it("gives money in a positive amount and takes the counter-account from the other column", () => {
        const { lines } = statement(
            into("18.09.2026", "Kari Nordmann", "2000,00", "33334455667"),
            out("19.09.2026", "Ola Nordmann", "-1500,00", "1111 22 33445"),
        );
        expect(lines).toMatchObject([
            { amount: 200000, counterAccount: "33334455667" },
            { amount: -150000, counterAccount: "11112233445" },
        ]);
    });

    it("leaves the counter-account out when the bank gives none", () => {
        const { lines } = statement(
            out("30.09.2026", "AVTALEGIRO 2 TRANS(ER) TYPE 156", "-3,00"),
            into("02.10.2026", "Nettbank", "500,00"),
        );
        expect(lines.map((l) => l.counterAccount)).toEqual([undefined, undefined]);
    });

    it("accepts whole kroner, one decimal, spaces and an Ut column without a minus", () => {
        const { lines } = statement(
            out("01.09.2026", "a", "12"),
            out("01.09.2026", "b", "-1 234,5"),
            out("01.09.2026", "c", "5,00"),
        );
        expect(lines.map((l) => l.amount)).toEqual([-1200, -123450, -500]);
    });

    it("gives identical lines different ids and the same ids in every export", () => {
        const twice = [
            out("14.09.2026", "Kari Nordmann", "-250,00", "33334455667"),
            out("14.09.2026", "Kari Nordmann", "-250,00", "33334455667"),
        ];
        const short = statement(...twice);
        const long = statement(
            out("20.09.2026", "x", "-1,00"),
            ...twice,
            out("01.09.2026", "y", "-2,00"),
        );
        const ids = short.lines.map((l) => l.lineId);
        expect(new Set(ids).size).toBe(2);
        expect(
            long.lines.filter((l) => l.description === "Kari Nordmann").map((l) => l.lineId),
        ).toEqual(ids);
    });

    it("sorts a file that is oldest first the same way", () => {
        const rows = [out("01.09.2026", "a", "-1,00"), out("02.09.2026", "b", "-2,00")];
        expect(statement(...rows)).toEqual(statement(...[...rows].reverse()));
    });

    it("refuses a file with other columns", () => {
        expect(() => parseStatement("Date;Text;Amount\n2026-09-01;x;1")).toThrow(
            "STATEMENT_FORMAT_UNKNOWN",
        );
        expect(() => parseStatement("Dato;Beskrivelse;Inn;Ut;Til konto\n")).toThrow(
            "missing: Fra konto",
        );
        expect(() => parseStatement("")).toThrow("STATEMENT_FORMAT_UNKNOWN");
    });

    it("refuses a file with a header only", () => {
        expect(() => parseStatement(HEADER + "\n")).toThrow("STATEMENT_EMPTY");
    });

    it("refuses lines it cannot read, naming the line and not its content", () => {
        const bad: Array<[string, string]> = [
            [out("2026-09-01", "hemmelig", "-1,00"), "line 2: the date"],
            [out("31.02.2026", "hemmelig", "-1,00"), "line 2: the date"],
            [
                `"01.09.2026";"hemmelig";;"1,00";"-1,00";"${OWN}";"${OWN}";`,
                "exactly one of Inn and Ut",
            ],
            [`"01.09.2026";"hemmelig"`, "exactly one of Inn and Ut"],
            [out("01.09.2026", "hemmelig", "-12.50"), "the amount is not a number"],
            [out("01.09.2026", "hemmelig", "0,00"), "the amount is not a number"],
            [into("01.09.2026", "hemmelig", "-5,00"), "the amount is not a number"],
            [`"01.09.2026";"hemmelig";;;"-1,00";"11112233445";;`, "own account number is missing"],
        ];
        for (const [row, reason] of bad) {
            let message = "";
            try {
                statement(row);
            } catch (e) {
                message = (e as Error).message;
            }
            expect(message).toContain("STATEMENT_LINE_INVALID");
            expect(message).toContain(reason);
            expect(message).not.toContain("hemmelig");
        }
    });

    it("refuses a file with lines from two accounts", () => {
        expect(() =>
            statement(
                out("01.09.2026", "a", "-1,00"),
                `"02.09.2026";"b";;;"-1,00";;"99998877665";`,
            ),
        ).toThrow("STATEMENT_SEVERAL_ACCOUNTS");
    });
});

describe("readStatement", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "fiken-statement-"));
        process.env.FIKEN_STATEMENT_DIR = dir;
    });

    afterEach(async () => {
        delete process.env.FIKEN_STATEMENT_DIR;
        await rm(dir, { recursive: true, force: true });
    });

    it("defaults to /statements", () => {
        delete process.env.FIKEN_STATEMENT_DIR;
        expect(statementDir()).toBe("/statements");
    });

    it("reads a file from the statement folder", async () => {
        await writeFile(join(dir, "2026-09.CSV"), await readFile(join(FIXTURES, "sparebank1.csv")));
        expect((await readStatement("2026-09.CSV")).lines).toHaveLength(13);
    });

    it("accepts only a plain .csv file name", async () => {
        for (const name of [
            "../x.csv",
            "a/b.csv",
            "a\\b.csv",
            "x.txt",
            ".hidden.csv",
            "",
            ".csv",
        ]) {
            await expect(readStatement(name)).rejects.toThrow("STATEMENT_FILE_INVALID");
        }
    });

    it("reports a missing file, and treats folders and links as missing", async () => {
        await mkdir(join(dir, "folder.csv"));
        await symlink("/etc/hostname", join(dir, "link.csv"));
        for (const name of ["none.csv", "folder.csv", "link.csv"]) {
            await expect(readStatement(name)).rejects.toThrow(
                `STATEMENT_NOT_FOUND: no file named ${name}`,
            );
        }
    });

    it("refuses a file over 2 MB", async () => {
        await writeFile(join(dir, "big.csv"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
        await expect(readStatement("big.csv")).rejects.toThrow("STATEMENT_TOO_LARGE");
    });

    it("rethrows other file errors", async () => {
        await writeFile(join(dir, "plain"), "x");
        process.env.FIKEN_STATEMENT_DIR = join(dir, "plain");
        await expect(readStatement("x.csv")).rejects.toThrow(/ENOTDIR/);
    });
});

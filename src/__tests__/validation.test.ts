import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    accountCode,
    checkLines,
    isoDate,
    ore,
    PURCHASE_VAT_TYPES,
    purchaseLine,
} from "../validation.js";

const line = (over: Partial<z.infer<typeof purchaseLine>> = {}) => ({
    text: "Fiskesluk",
    account: "6540",
    vatType: "HIGH" as const,
    net: 39920,
    gross: 49900,
    ...over,
});

function issues(lines: ReturnType<typeof line>[], total: number) {
    const schema = z
        .object({ lines: z.array(purchaseLine), totalGross: ore })
        .superRefine((v, ctx) => checkLines(v.lines, v.totalGross, ctx));
    const r = schema.safeParse({ lines, totalGross: total });
    return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("field validators", () => {
    it("accepts real ISO dates only", () => {
        expect(isoDate.safeParse("2026-09-28").success).toBe(true);
        for (const bad of ["28.09.2026", "2026-9-28", "2026-02-30", "2026-13-01", ""]) {
            expect(isoDate.safeParse(bad).success).toBe(false);
        }
    });

    it("requires whole øre", () => {
        expect(ore.safeParse(49900).success).toBe(true);
        expect(ore.safeParse(499.0).success).toBe(true);
        expect(ore.safeParse(499.5).success).toBe(false);
        expect(ore.safeParse("49900").success).toBe(false);
    });

    it("accepts Fiken account codes", () => {
        for (const good of ["6540", "1920:10001"])
            expect(accountCode.safeParse(good).success).toBe(true);
        for (const bad of ["654", "6540:", "Inventar", "6540 "]) {
            expect(accountCode.safeParse(bad).success).toBe(false);
        }
    });

    it("only allows Fiken purchase VAT types", () => {
        expect(PURCHASE_VAT_TYPES).toHaveLength(16);
        expect(purchaseLine.safeParse(line({ vatType: "EXEMPT" as never })).success).toBe(false);
        expect(purchaseLine.safeParse(line({ text: "" })).success).toBe(false);
    });
});

describe("checkLines", () => {
    it("accepts consistent 25 %, 15 %, 12 % and 0 % lines", () => {
        const lines = [
            line(),
            line({ vatType: "MEDIUM", net: 10000, gross: 11500 }),
            line({ vatType: "LOW", net: 10000, gross: 11200 }),
            line({ vatType: "NONE", net: 5000, gross: 5000 }),
        ];
        expect(issues(lines, 49900 + 11500 + 11200 + 5000)).toEqual([]);
    });

    it("allows 1 øre of rounding per line", () => {
        expect(issues([line({ net: 39920, gross: 49901 })], 49901)).toEqual([]);
        expect(issues([line(), line()], 99801)).toEqual([]);
        expect(issues([line(), line()], 99803)).toHaveLength(1);
    });

    it("rejects a gross that does not match the VAT rate", () => {
        expect(issues([line({ gross: 45000 })], 45000)[0]).toContain(
            "gross 45000 does not match net 39920 with HIGH VAT",
        );
        expect(issues([line({ vatType: "NONE", net: 100, gross: 125 })], 125)[0]).toContain("NONE");
    });

    it("skips the per-line VAT check for reverse-charge and basis types", () => {
        expect(
            issues(
                [line({ vatType: "HIGH_FOREIGN_SERVICE_DEDUCTIBLE", net: 1000, gross: 1000 })],
                1000,
            ),
        ).toEqual([]);
    });

    it("rejects lines that do not add up to the receipt total", () => {
        expect(issues([line()], 59900)).toEqual([
            "lines add up to 49900 øre but the receipt total is 59900 øre",
        ]);
    });
});

import { z } from "zod";

/** Purchase VAT types accepted by Fiken (draftLineRequest.vatType in the v2 spec). */
export const PURCHASE_VAT_TYPES = [
    "NONE",
    "HIGH",
    "MEDIUM",
    "RAW_FISH",
    "LOW",
    "HIGH_DIRECT",
    "HIGH_BASIS",
    "MEDIUM_DIRECT",
    "MEDIUM_BASIS",
    "NONE_IMPORT_BASIS",
    "HIGH_FOREIGN_SERVICE_DEDUCTIBLE",
    "HIGH_FOREIGN_SERVICE_NONDEDUCTIBLE",
    "LOW_FOREIGN_SERVICE_DEDUCTIBLE",
    "LOW_FOREIGN_SERVICE_NONDEDUCTIBLE",
    "HIGH_PURCHASE_OF_EMISSIONSTRADING_OR_GOLD_DEDUCTIBLE",
    "HIGH_PURCHASE_OF_EMISSIONSTRADING_OR_GOLD_NONDEDUCTIBLE",
] as const;

/** Domestic rates where gross must equal net plus VAT on the line itself. */
const LINE_VAT_RATES: Partial<Record<(typeof PURCHASE_VAT_TYPES)[number], number>> = {
    NONE: 0,
    HIGH: 0.25,
    MEDIUM: 0.15,
    LOW: 0.12,
    RAW_FISH: 0.1111,
};

function isRealDate(value: string): boolean {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format")
    .refine(isRealDate, "must be a real calendar date");

export const ore = z.number().int("must be a whole number of øre (1 NOK = 100 øre)");

export const accountCode = z
    .string()
    .regex(/^\d{4}(:\d+)?$/, 'must be a Fiken account code such as "6540" or "1920:10001"');

export const purchaseLine = z.object({
    text: z.string().min(1).describe("What was bought, e.g. 'Fiskeutstyr til utleiebåt'"),
    account: accountCode.describe('Expense account, e.g. "6540"'),
    vatType: z.enum(PURCHASE_VAT_TYPES),
    net: ore.describe("Net amount in øre (excluding VAT)"),
    gross: ore.describe("Gross amount in øre (including VAT)"),
    projectId: z.number().int().positive().optional(),
});

export type PurchaseLine = z.infer<typeof purchaseLine>;

/** Lines must match the receipt total, and domestic VAT must add up per line. */
export function checkLines(lines: PurchaseLine[], totalGross: number, ctx: z.RefinementCtx): void {
    const tolerance = lines.length; // 1 øre of rounding per line
    lines.forEach((line, i) => {
        const rate = LINE_VAT_RATES[line.vatType];
        if (rate === undefined) return;
        const expected = Math.round(line.net * (1 + rate));
        if (Math.abs(line.gross - expected) > 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["lines", i, "gross"],
                message: `gross ${line.gross} does not match net ${line.net} with ${line.vatType} VAT (expected about ${expected})`,
            });
        }
    });
    const sum = lines.reduce((acc, line) => acc + line.gross, 0);
    if (Math.abs(sum - totalGross) > tolerance) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["totalGross"],
            message: `lines add up to ${sum} øre but the receipt total is ${totalGross} øre`,
        });
    }
}

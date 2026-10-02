import { accountCode } from "./validation.js";

/**
 * Settings for the bank statement tools. They come from the environment only, so
 * neither a tool caller nor text in a statement can change which accounts count
 * as private.
 */

export interface BankConfig {
    /** Ledger account of the bank account the statements belong to. */
    bankAccount: string;
    /** Bank account numbers whose transfers are personlig innskudd/uttak. */
    privateBankAccounts: ReadonlySet<string>;
    /** Ledger account private transfers are posted against, e.g. "2061". */
    privateLedgerAccount?: string;
}

export type BookingConfig = BankConfig & { privateLedgerAccount: string };

const BANK_ACCOUNT_NUMBER = /^\d{11}$/;

/** A bank account number as digits only ("1234 56 78903" and "1234.56.78903" are the same). */
export function accountNumber(raw: string): string {
    return raw.replace(/[\s.]/g, "");
}

export function bankConfig(env: NodeJS.ProcessEnv = process.env): BankConfig {
    const bankAccount = env.FIKEN_BANK_ACCOUNT || "1920:10001";
    if (!accountCode.safeParse(bankAccount).success) {
        throw new Error(
            'BANK_CONFIG_INVALID: FIKEN_BANK_ACCOUNT must be a Fiken account code such as "1920:10001"',
        );
    }
    const numbers = (env.FIKEN_PRIVATE_BANK_ACCOUNTS ?? "")
        .split(",")
        .map(accountNumber)
        .filter((n) => n !== "");
    const bad = numbers.filter((n) => !BANK_ACCOUNT_NUMBER.test(n)).length;
    if (bad > 0) {
        throw new Error(
            `BANK_CONFIG_INVALID: FIKEN_PRIVATE_BANK_ACCOUNTS must be 11-digit account numbers separated by commas (${bad} of ${numbers.length} are not)`,
        );
    }
    const privateLedgerAccount = env.FIKEN_PRIVATE_LEDGER_ACCOUNT || undefined;
    if (
        privateLedgerAccount !== undefined &&
        !accountCode.safeParse(privateLedgerAccount).success
    ) {
        throw new Error(
            'BANK_CONFIG_INVALID: FIKEN_PRIVATE_LEDGER_ACCOUNT must be a Fiken account code such as "2061"',
        );
    }
    return { bankAccount, privateBankAccounts: new Set(numbers), privateLedgerAccount };
}

/** The settings needed to book private transfers, or an error naming what is missing. */
export function bookingConfig(env: NodeJS.ProcessEnv = process.env): BookingConfig {
    const config = bankConfig(env);
    const missing = [
        config.privateBankAccounts.size === 0 ? "FIKEN_PRIVATE_BANK_ACCOUNTS" : "",
        config.privateLedgerAccount === undefined ? "FIKEN_PRIVATE_LEDGER_ACCOUNT" : "",
    ].filter((name) => name !== "");
    if (missing.length > 0) {
        throw new Error(`PRIVATE_TRANSFERS_NOT_CONFIGURED: set ${missing.join(" and ")}`);
    }
    return config as BookingConfig;
}

/** FIKEN_PRIVATE_TRANSFERS: "on" enables the booking tool; unset or "off" leaves it out. */
export function privateTransfersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env.FIKEN_PRIVATE_TRANSFERS ?? "off";
    if (value !== "on" && value !== "off") {
        throw new Error('FIKEN_PRIVATE_TRANSFERS must be "on" or "off"');
    }
    return value === "on";
}

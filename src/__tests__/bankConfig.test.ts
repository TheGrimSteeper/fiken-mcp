import { describe, it, expect, afterEach } from "vitest";
import {
    accountNumber,
    bankConfig,
    bookingConfig,
    privateTransfersEnabled,
} from "../bankConfig.js";

const KEYS = [
    "FIKEN_BANK_ACCOUNT",
    "FIKEN_PRIVATE_BANK_ACCOUNTS",
    "FIKEN_PRIVATE_LEDGER_ACCOUNT",
    "FIKEN_PRIVATE_TRANSFERS",
];

afterEach(() => {
    for (const key of KEYS) delete process.env[key];
});

describe("accountNumber", () => {
    it("keeps the digits of a number written with spaces or dots", () => {
        expect(accountNumber(" 1234 56 78903 ")).toBe("12345678903");
        expect(accountNumber("1234.56.78903")).toBe("12345678903");
    });
});

describe("bankConfig", () => {
    it("defaults to the first bank account and no private accounts", () => {
        expect(bankConfig({})).toEqual({
            bankAccount: "1920:10001",
            privateBankAccounts: new Set(),
            privateLedgerAccount: undefined,
        });
    });

    it("reads the process environment when none is given", () => {
        process.env.FIKEN_BANK_ACCOUNT = "1920:10002";
        expect(bankConfig().bankAccount).toBe("1920:10002");
    });

    it("reads a comma-separated list of private bank accounts", () => {
        const config = bankConfig({
            FIKEN_PRIVATE_BANK_ACCOUNTS: "1111 22 33445, 2222.33.44556,,",
            FIKEN_PRIVATE_LEDGER_ACCOUNT: "2061",
        });
        expect([...config.privateBankAccounts]).toEqual(["11112233445", "22223344556"]);
        expect(config.privateLedgerAccount).toBe("2061");
    });

    it("refuses malformed settings without echoing the account numbers", () => {
        expect(() => bankConfig({ FIKEN_BANK_ACCOUNT: "bank" })).toThrow(
            "BANK_CONFIG_INVALID: FIKEN_BANK_ACCOUNT",
        );
        expect(() => bankConfig({ FIKEN_PRIVATE_BANK_ACCOUNTS: "11112233445,123" })).toThrow(
            "FIKEN_PRIVATE_BANK_ACCOUNTS must be 11-digit account numbers separated by commas (1 of 2 are not)",
        );
        expect(() => bankConfig({ FIKEN_PRIVATE_LEDGER_ACCOUNT: "privat" })).toThrow(
            "BANK_CONFIG_INVALID: FIKEN_PRIVATE_LEDGER_ACCOUNT",
        );
    });
});

describe("bookingConfig", () => {
    it("names every missing setting", () => {
        expect(() => bookingConfig({})).toThrow(
            "PRIVATE_TRANSFERS_NOT_CONFIGURED: set FIKEN_PRIVATE_BANK_ACCOUNTS and FIKEN_PRIVATE_LEDGER_ACCOUNT",
        );
        expect(() => bookingConfig({ FIKEN_PRIVATE_LEDGER_ACCOUNT: "2061" })).toThrow(
            "set FIKEN_PRIVATE_BANK_ACCOUNTS",
        );
        expect(() => bookingConfig({ FIKEN_PRIVATE_BANK_ACCOUNTS: "11112233445" })).toThrow(
            "set FIKEN_PRIVATE_LEDGER_ACCOUNT",
        );
    });

    it("returns complete settings, by default from the process environment", () => {
        process.env.FIKEN_PRIVATE_BANK_ACCOUNTS = "11112233445";
        process.env.FIKEN_PRIVATE_LEDGER_ACCOUNT = "2061";
        expect(bookingConfig()).toEqual({
            bankAccount: "1920:10001",
            privateBankAccounts: new Set(["11112233445"]),
            privateLedgerAccount: "2061",
        });
    });
});

describe("privateTransfersEnabled", () => {
    it("is off unless switched on", () => {
        expect(privateTransfersEnabled({})).toBe(false);
        expect(privateTransfersEnabled({ FIKEN_PRIVATE_TRANSFERS: "off" })).toBe(false);
        expect(privateTransfersEnabled({ FIKEN_PRIVATE_TRANSFERS: "on" })).toBe(true);
        expect(privateTransfersEnabled()).toBe(false);
    });

    it("refuses other values", () => {
        for (const value of ["", "true", "ON"]) {
            expect(() => privateTransfersEnabled({ FIKEN_PRIVATE_TRANSFERS: value })).toThrow(
                "FIKEN_PRIVATE_TRANSFERS",
            );
        }
    });
});

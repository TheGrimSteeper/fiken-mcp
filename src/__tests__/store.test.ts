import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    audit,
    dataDir,
    getDocument,
    getTransfers,
    updateDocument,
    updateTransfer,
    withStateLock,
} from "../store.js";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fiken-store-"));
    process.env.FIKEN_DATA_DIR = join(dir, "data");
});

afterEach(async () => {
    delete process.env.FIKEN_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
    it("defaults to /data", () => {
        delete process.env.FIKEN_DATA_DIR;
        expect(dataDir()).toBe("/data");
    });

    it("returns an empty entry before anything is stored", async () => {
        expect(await getDocument(42)).toEqual({});
    });

    it("merges updates and persists them as JSON", async () => {
        await updateDocument(42, { inboxDocumentId: 901 });
        const merged = await updateDocument(42, { draftId: 555 });
        expect(merged).toEqual({ inboxDocumentId: 901, draftId: 555 });
        expect(await getDocument(42)).toEqual(merged);
        expect(await getDocument(7)).toEqual({});
        const raw = JSON.parse(await readFile(join(dir, "data", "state.json"), "utf8"));
        expect(raw).toEqual({ version: 1, documents: { "42": merged } });
    });

    it("keeps private transfers beside the documents", async () => {
        expect(await getTransfers()).toEqual({});
        await updateDocument(42, { draftId: 555 });
        await updateTransfer("abc", { attemptedAt: "t1", amount: -100 });
        const merged = await updateTransfer("abc", { bookedAt: "t2" });
        await updateTransfer("def", { attemptedAt: "t3" });
        expect(merged).toEqual({ attemptedAt: "t1", amount: -100, bookedAt: "t2" });
        expect(await getTransfers()).toEqual({ abc: merged, def: { attemptedAt: "t3" } });
        expect(await getDocument(42)).toEqual({ draftId: 555 });
    });

    it("refuses a state file with an unknown format", async () => {
        await mkdir(join(dir, "data"), { recursive: true });
        await writeFile(join(dir, "data", "state.json"), JSON.stringify({ version: 2 }));
        await expect(getDocument(1)).rejects.toThrow("STATE_INVALID");
        await writeFile(join(dir, "data", "state.json"), "null");
        await expect(getDocument(1)).rejects.toThrow("STATE_INVALID");
    });

    it("rethrows read errors other than a missing file", async () => {
        await mkdir(join(dir, "data", "state.json"), { recursive: true });
        await expect(getDocument(1)).rejects.toThrow(/EISDIR/);
    });

    it("appends audit lines with a timestamp", async () => {
        await audit({ tool: "t", event: "a", ok: true, draftId: 1 });
        await audit({ tool: "t", event: "b", ok: false, error: "x" });
        const lines = (await readFile(join(dir, "data", "audit.jsonl"), "utf8")).trim().split("\n");
        expect(lines.map((l) => JSON.parse(l))).toEqual([
            {
                ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                tool: "t",
                event: "a",
                ok: true,
                draftId: 1,
            },
            { ts: expect.any(String), tool: "t", event: "b", ok: false, error: "x" },
        ]);
    });

    it("runs locked sections one at a time, even after a failure", async () => {
        const order: string[] = [];
        const slow = withStateLock(async () => {
            order.push("a-start");
            await new Promise((r) => setTimeout(r, 10));
            order.push("a-end");
            throw new Error("a failed");
        });
        const next = withStateLock(async () => {
            order.push("b");
            return "b";
        });
        await expect(slow).rejects.toThrow("a failed");
        await expect(next).resolves.toBe("b");
        expect(order).toEqual(["a-start", "a-end", "b"]);
    });
});

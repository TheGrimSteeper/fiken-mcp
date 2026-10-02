import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persistent state for the Paperless → Fiken draft flow, kept in FIKEN_DATA_DIR:
 * - state.json: per Paperless document, the Fiken ids created so far, so retries
 *   resume instead of duplicating inbox documents or drafts. Also, per bank statement
 *   line booked as a private transfer, when it was attempted and booked.
 * - audit.jsonl: one JSON line per write attempt.
 */

export interface DocumentState {
    inboxDocumentId?: number;
    importedAt?: string;
    draftAttemptedAt?: string;
    draftId?: number;
    draftedAt?: string;
    attachedAt?: string;
}

/** A statement line booked as a private transfer, keyed by its lineId. */
export interface TransferState {
    attemptedAt?: string;
    bookedAt?: string;
    /** Location header Fiken returned for the entry. */
    location?: string;
    date?: string;
    amount?: number;
}

interface StateFile {
    version: 1;
    documents: Record<string, DocumentState>;
    transfers?: Record<string, TransferState>;
}

export function dataDir(): string {
    return process.env.FIKEN_DATA_DIR || "/data";
}

async function load(): Promise<StateFile> {
    try {
        const parsed = JSON.parse(await readFile(join(dataDir(), "state.json"), "utf8"));
        if (parsed?.version !== 1 || typeof parsed.documents !== "object") {
            throw new Error("STATE_INVALID: state.json has an unknown format");
        }
        return parsed as StateFile;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, documents: {} };
        throw e;
    }
}

async function save(state: StateFile): Promise<void> {
    await mkdir(dataDir(), { recursive: true });
    const file = join(dataDir(), "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(tmp, file);
}

let lock: Promise<unknown> = Promise.resolve();

/** Run `fn` with exclusive access to the state file. */
export function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = lock.then(fn, fn);
    lock = result.catch(() => undefined);
    return result;
}

export async function getDocument(paperlessId: number): Promise<DocumentState> {
    return (await load()).documents[String(paperlessId)] ?? {};
}

export async function updateDocument(
    paperlessId: number,
    patch: Partial<DocumentState>,
): Promise<DocumentState> {
    const state = await load();
    const next = { ...state.documents[String(paperlessId)], ...patch };
    state.documents[String(paperlessId)] = next;
    await save(state);
    return next;
}

export async function getTransfers(): Promise<Record<string, TransferState>> {
    return (await load()).transfers ?? {};
}

export async function updateTransfer(
    lineId: string,
    patch: Partial<TransferState>,
): Promise<TransferState> {
    const state = await load();
    const transfers = state.transfers ?? {};
    const next = { ...transfers[lineId], ...patch };
    transfers[lineId] = next;
    await save({ ...state, transfers });
    return next;
}

export interface AuditEntry {
    tool: string;
    event: string;
    ok: boolean;
    paperlessDocumentId?: number;
    inboxDocumentId?: number;
    draftId?: number;
    totalGross?: number;
    /** Private transfers: the statement line, its amount in øre and Fiken's Location header. */
    lineId?: string;
    amount?: number;
    location?: string;
    error?: string;
}

/** Append one audit line. Never include tokens or file contents. */
export async function audit(entry: AuditEntry): Promise<void> {
    await mkdir(dataDir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await appendFile(join(dataDir(), "audit.jsonl"), line + "\n", "utf8");
}

/**
 * Process-wide request limiter for the Fiken API.
 *
 * Fiken allows a single concurrent request per client and may ban clients that
 * break this rule. Every HTTP call goes through `schedule`, which runs tasks one
 * at a time, keeps a minimum gap between them and enforces a daily budget.
 */

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    return n;
}

export function minIntervalMs(): number {
    return intEnv("FIKEN_MIN_INTERVAL_MS", 350);
}

export function dailyLimit(): number {
    return intEnv("FIKEN_DAILY_REQUEST_LIMIT", 1000);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let tail: Promise<unknown> = Promise.resolve();
let lastFinished = 0;
let budgetDay = "";
let budgetUsed = 0;

/** Reset all limiter state. Only for tests. */
export function resetLimiter(): void {
    tail = Promise.resolve();
    lastFinished = 0;
    budgetDay = "";
    budgetUsed = 0;
}

function takeBudget(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== budgetDay) {
        budgetDay = today;
        budgetUsed = 0;
    }
    if (budgetUsed >= dailyLimit()) {
        throw new Error(
            "FIKEN_DAILY_LIMIT: daily Fiken request budget used up; try again tomorrow or raise FIKEN_DAILY_REQUEST_LIMIT",
        );
    }
    budgetUsed++;
}

/** Run `task` after every previously scheduled task has finished. */
export function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
        // Capped at the interval so a clock jump backwards can't stall the queue.
        const interval = minIntervalMs();
        const wait = Math.min(interval, lastFinished + interval - Date.now());
        if (wait > 0) await sleep(wait);
        try {
            takeBudget();
            return await task();
        } finally {
            lastFinished = Date.now();
        }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
}

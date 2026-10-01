import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { schedule, resetLimiter, minIntervalMs, dailyLimit } from "../limiter.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("limiter", () => {
    const saved = { ...process.env };

    beforeEach(() => {
        resetLimiter();
        process.env.FIKEN_MIN_INTERVAL_MS = "0";
        delete process.env.FIKEN_DAILY_REQUEST_LIMIT;
    });

    afterEach(() => {
        process.env = { ...saved };
    });

    it("never runs two tasks at the same time", async () => {
        let active = 0;
        let maxActive = 0;
        const order: number[] = [];
        const tasks = Array.from({ length: 20 }, (_, i) =>
            schedule(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await delay(2);
                order.push(i);
                active--;
                return i;
            }),
        );
        expect(await Promise.all(tasks)).toEqual(order);
        expect(maxActive).toBe(1);
        expect(order).toEqual([...Array(20).keys()]);
    });

    it("keeps the minimum interval between tasks", async () => {
        process.env.FIKEN_MIN_INTERVAL_MS = "40";
        const starts: number[] = [];
        await Promise.all(
            [0, 1, 2].map(() =>
                schedule(async () => {
                    starts.push(Date.now());
                }),
            ),
        );
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(35);
        expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(35);
    });

    it("keeps going after a task fails", async () => {
        const failed = schedule(async () => {
            throw new Error("boom");
        });
        const next = schedule(async () => "ok");
        await expect(failed).rejects.toThrow("boom");
        await expect(next).resolves.toBe("ok");
    });

    it("refuses tasks once the daily budget is used up", async () => {
        process.env.FIKEN_DAILY_REQUEST_LIMIT = "2";
        let ran = 0;
        const task = async () => {
            ran++;
        };
        await schedule(task);
        await schedule(task);
        await expect(schedule(task)).rejects.toThrow("FIKEN_DAILY_LIMIT");
        expect(ran).toBe(2);
    });

    it("uses defaults and validates env values", () => {
        delete process.env.FIKEN_MIN_INTERVAL_MS;
        expect(minIntervalMs()).toBe(350);
        expect(dailyLimit()).toBe(1000);
        process.env.FIKEN_MIN_INTERVAL_MS = "";
        expect(minIntervalMs()).toBe(350);
        for (const bad of ["-1", "1.5", "abc"]) {
            process.env.FIKEN_DAILY_REQUEST_LIMIT = bad;
            expect(() => dailyLimit()).toThrow("FIKEN_DAILY_REQUEST_LIMIT");
        }
    });
});

describe("limiter clock safety", () => {
    it("never waits longer than the interval, even if the clock jumped backwards", async () => {
        resetLimiter();
        process.env.FIKEN_MIN_INTERVAL_MS = "20";
        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 60_000;
            await schedule(async () => undefined);
            Date.now = realNow;
            const started = realNow();
            await schedule(async () => undefined);
            expect(realNow() - started).toBeLessThan(1000);
        } finally {
            Date.now = realNow;
            process.env.FIKEN_MIN_INTERVAL_MS = "0";
        }
    });
});

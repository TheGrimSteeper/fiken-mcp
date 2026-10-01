import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Inline fetch mock before importing client
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { get, mutate, cp, slug, uploadMultipart } from "../client.js";
import { resetLimiter } from "../limiter.js";

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    const headersMap = new Map(Object.entries(headers));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headersMap.get(name) ?? null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    };
}

describe("client", () => {
    const ORIG_TOKEN = process.env.FIKEN_API_TOKEN;
    const ORIG_SLUG = process.env.FIKEN_COMPANY_SLUG;

    beforeEach(() => {
        process.env.FIKEN_API_TOKEN = "test-token";
        process.env.FIKEN_COMPANY_SLUG = "test-slug";
        mockFetch.mockReset();
        resetLimiter();
    });

    afterEach(() => {
        process.env.FIKEN_API_TOKEN = ORIG_TOKEN;
        process.env.FIKEN_COMPANY_SLUG = ORIG_SLUG;
    });

    describe("slug()", () => {
        it("returns FIKEN_COMPANY_SLUG env var", () => {
            expect(slug()).toBe("test-slug");
        });

        it("throws when FIKEN_COMPANY_SLUG is not set", () => {
            delete process.env.FIKEN_COMPANY_SLUG;
            expect(() => slug()).toThrow("FIKEN_COMPANY_SLUG environment variable is required");
        });
    });

    describe("cp()", () => {
        it("builds company-scoped path", () => {
            expect(cp("/invoices")).toBe("/companies/test-slug/invoices");
        });

        it("handles empty path suffix", () => {
            expect(cp("")).toBe("/companies/test-slug");
        });
    });

    describe("get()", () => {
        it("throws when FIKEN_API_TOKEN is not set", async () => {
            delete process.env.FIKEN_API_TOKEN;
            await expect(get("/user")).rejects.toThrow(
                "FIKEN_API_TOKEN environment variable is required",
            );
        });

        it("fetches with Bearer auth header", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, { name: "Test" }));
            await get("/user");
            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, init] = mockFetch.mock.calls[0];
            expect(String(url)).toBe("https://api.fiken.no/api/v2/user");
            expect(init.headers.Authorization).toBe("Bearer test-token");
        });

        it("returns parsed JSON on 200", async () => {
            const data = { id: 1, name: "Test" };
            mockFetch.mockResolvedValue(makeResponse(200, data));
            const result = await get("/user");
            expect(result).toEqual(data);
        });

        it("returns null on 204", async () => {
            mockFetch.mockResolvedValue(makeResponse(204, null));
            const result = await get("/user");
            expect(result).toBeNull();
        });

        it("throws on non-ok response", async () => {
            mockFetch.mockResolvedValue(makeResponse(404, "Not found"));
            await expect(get("/user")).rejects.toThrow("Fiken 404: Not found");
        });

        it("throws on 500 error", async () => {
            mockFetch.mockResolvedValue(makeResponse(500, "Internal Server Error"));
            await expect(get("/user")).rejects.toThrow("Fiken 500: Internal Server Error");
        });

        it("appends non-null params as query string", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, []));
            await get("/companies", { page: 0, pageSize: 10, sortBy: "name asc" });
            const [url] = mockFetch.mock.calls[0];
            const u = new URL(String(url));
            expect(u.searchParams.get("page")).toBe("0");
            expect(u.searchParams.get("pageSize")).toBe("10");
            expect(u.searchParams.get("sortBy")).toBe("name asc");
        });

        it("skips null and undefined params", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, []));
            await get("/contacts", { page: 1, name: null, inactive: undefined });
            const [url] = mockFetch.mock.calls[0];
            const u = new URL(String(url));
            expect(u.searchParams.get("page")).toBe("1");
            expect(u.searchParams.has("name")).toBe(false);
            expect(u.searchParams.has("inactive")).toBe(false);
        });

        it("works with no params", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, {}));
            await get("/user");
            const [url] = mockFetch.mock.calls[0];
            expect(String(url)).toBe("https://api.fiken.no/api/v2/user");
        });

        it("converts boolean param to string", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, []));
            await get("/contacts", { customer: true });
            const [url] = mockFetch.mock.calls[0];
            const u = new URL(String(url));
            expect(u.searchParams.get("customer")).toBe("true");
        });
    });

    describe("mutate()", () => {
        it("throws when FIKEN_API_TOKEN is not set", async () => {
            delete process.env.FIKEN_API_TOKEN;
            await expect(mutate("POST", "/companies/test-slug/invoices", {})).rejects.toThrow(
                "FIKEN_API_TOKEN environment variable is required",
            );
        });

        it("sends POST with body and correct headers", async () => {
            mockFetch.mockResolvedValue(makeResponse(204, null));
            await mutate("POST", "/companies/test-slug/invoices", { issueDate: "2024-01-01" });
            const [url, init] = mockFetch.mock.calls[0];
            expect(String(url)).toBe("https://api.fiken.no/api/v2/companies/test-slug/invoices");
            expect(init.method).toBe("POST");
            expect(init.headers.Authorization).toBe("Bearer test-token");
            expect(init.headers["Content-Type"]).toBe("application/json");
            expect(init.body).toBe(JSON.stringify({ issueDate: "2024-01-01" }));
        });

        it("sends no body when body is undefined", async () => {
            mockFetch.mockResolvedValue(makeResponse(204, null));
            await mutate("DELETE", "/companies/test-slug/contacts/1");
            const [, init] = mockFetch.mock.calls[0];
            expect(init.body).toBeUndefined();
        });

        it("returns {success: true} on 204", async () => {
            mockFetch.mockResolvedValue(makeResponse(204, null));
            const result = await mutate("DELETE", "/companies/test-slug/contacts/1");
            expect(result).toEqual({ success: true });
        });

        it("returns {created: true, location} on 201", async () => {
            mockFetch.mockResolvedValue(
                makeResponse(201, null, { Location: "/companies/test-slug/invoices/99" }),
            );
            const result = (await mutate("POST", "/companies/test-slug/invoices", {})) as Record<
                string,
                unknown
            >;
            expect(result).toEqual({ created: true, location: "/companies/test-slug/invoices/99" });
        });

        it("returns parsed JSON on 200", async () => {
            const data = { saleId: 5 };
            mockFetch.mockResolvedValue(makeResponse(200, data));
            const result = await mutate("POST", "/companies/test-slug/sales", {});
            expect(result).toEqual(data);
        });

        it("returns {success: true} when 200 body is not valid JSON", async () => {
            const badResponse = {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.reject(new SyntaxError("bad json")),
                text: () => Promise.resolve("ok"),
            };
            mockFetch.mockResolvedValue(badResponse);
            const result = await mutate("PATCH", "/some/path");
            expect(result).toEqual({ success: true });
        });

        it("throws on non-ok response", async () => {
            mockFetch.mockResolvedValue(makeResponse(400, "Bad Request"));
            await expect(mutate("POST", "/companies/test-slug/invoices", {})).rejects.toThrow(
                "Fiken 400: Bad Request",
            );
        });

        it("sends PUT with body", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, { id: 1 }));
            await mutate("PUT", "/companies/test-slug/contacts/1", { name: "Updated" });
            const [, init] = mockFetch.mock.calls[0];
            expect(init.method).toBe("PUT");
            expect(init.body).toBe(JSON.stringify({ name: "Updated" }));
        });

        it("sends PATCH with body", async () => {
            mockFetch.mockResolvedValue(makeResponse(200, {}));
            await mutate("PATCH", "/path", { dueDate: "2024-12-31" });
            const [, init] = mockFetch.mock.calls[0];
            expect(init.method).toBe("PATCH");
        });
    });

    describe("uploadMultipart()", () => {
        it("throws when FIKEN_API_TOKEN is not set", async () => {
            delete process.env.FIKEN_API_TOKEN;
            await expect(
                uploadMultipart("/companies/test-slug/purchases/1/attachments", {}, new FormData()),
            ).rejects.toThrow("FIKEN_API_TOKEN environment variable is required");
        });

        it("sends POST with auth, query params, and multipart body", async () => {
            mockFetch.mockResolvedValue(
                makeResponse(201, null, {
                    Location: "/companies/test-slug/purchases/1/attachments/2",
                }),
            );
            const form = new FormData();
            form.append("filename", "receipt.pdf");
            form.append("file", new Blob([Buffer.from("pdf")]), "receipt.pdf");

            const result = await uploadMultipart(
                "/companies/test-slug/purchases/1/attachments",
                { attachToPayment: false, attachToSale: true },
                form,
            );

            const [url, init] = mockFetch.mock.calls[0];
            const u = new URL(String(url));
            expect(u.pathname).toBe("/api/v2/companies/test-slug/purchases/1/attachments");
            expect(u.searchParams.get("attachToPayment")).toBe("false");
            expect(u.searchParams.get("attachToSale")).toBe("true");
            expect(init.method).toBe("POST");
            expect(init.headers.Authorization).toBe("Bearer test-token");
            expect(init.headers["Content-Type"]).toBeUndefined();
            expect(init.body).toBe(form);
            expect(result).toEqual({
                created: true,
                location: "/companies/test-slug/purchases/1/attachments/2",
            });
        });

        it("throws on non-ok response", async () => {
            mockFetch.mockResolvedValue(makeResponse(400, "Bad Request"));
            await expect(
                uploadMultipart("/companies/test-slug/purchases/1/attachments", {}, new FormData()),
            ).rejects.toThrow("Fiken 400: Bad Request");
        });
    });
    describe("limiter integration and retries", () => {
        it("retries a GET on 429 and 503, then returns the success", async () => {
            mockFetch
                .mockResolvedValueOnce(makeResponse(429, "slow down"))
                .mockResolvedValueOnce(makeResponse(503, "busy", { "Retry-After": "0" }))
                .mockResolvedValueOnce(makeResponse(200, { ok: 1 }));
            await expect(get("/user")).resolves.toEqual({ ok: 1 });
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it("waits for Retry-After seconds before retrying a GET", async () => {
            vi.useFakeTimers();
            try {
                mockFetch
                    .mockResolvedValueOnce(makeResponse(429, "slow down", { "Retry-After": "2" }))
                    .mockResolvedValueOnce(makeResponse(200, { ok: 1 }));
                const pending = get("/user");
                await vi.advanceTimersByTimeAsync(1999);
                expect(mockFetch).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                await expect(pending).resolves.toEqual({ ok: 1 });
            } finally {
                vi.useRealTimers();
            }
        });

        it.each([
            ["invalid", "nope"],
            ["unset", undefined],
        ])("uses a 1 s backoff base when FIKEN_RETRY_BASE_MS is %s", async (_label, value) => {
            if (value === undefined) delete process.env.FIKEN_RETRY_BASE_MS;
            else process.env.FIKEN_RETRY_BASE_MS = value;
            vi.useFakeTimers();
            try {
                mockFetch
                    .mockResolvedValueOnce(makeResponse(429, "slow down"))
                    .mockResolvedValueOnce(makeResponse(200, { ok: 1 }));
                const pending = get("/user");
                await vi.advanceTimersByTimeAsync(999);
                expect(mockFetch).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                await expect(pending).resolves.toEqual({ ok: 1 });
            } finally {
                vi.useRealTimers();
                process.env.FIKEN_RETRY_BASE_MS = "0";
            }
        });

        it("gives up on a GET after three retries", async () => {
            mockFetch.mockResolvedValue(makeResponse(429, "slow down"));
            await expect(get("/user")).rejects.toThrow("Fiken 429: slow down");
            expect(mockFetch).toHaveBeenCalledTimes(4);
        });

        it("never retries a write on 429", async () => {
            mockFetch.mockResolvedValue(makeResponse(429, "slow down"));
            await expect(mutate("POST", "/x", {})).rejects.toThrow("Fiken 429");
            expect(mockFetch).toHaveBeenCalledOnce();
        });

        it("warns that a write may have completed when the connection fails", async () => {
            mockFetch.mockRejectedValue(new Error("socket hang up"));
            await expect(mutate("POST", "/x", {})).rejects.toThrow(
                "Fiken request failed (socket hang up). A write may have completed: read back before retrying.",
            );
            mockFetch.mockRejectedValue("reset");
            await expect(uploadMultipart("/x", undefined, new FormData())).rejects.toThrow(
                "Fiken request failed (reset)",
            );
        });

        it("rethrows network errors on reads unchanged", async () => {
            mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
            await expect(get("/user")).rejects.toThrow("ECONNREFUSED");
        });

        it("truncates long error bodies", async () => {
            mockFetch.mockResolvedValue(makeResponse(400, "x".repeat(5000)));
            const err = await get("/user").catch((e: Error) => e);
            expect((err as Error).message.length).toBe("Fiken 400: ".length + 1000);
        });
    });
});

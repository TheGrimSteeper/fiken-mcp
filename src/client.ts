import { schedule } from "./limiter.js";

const BASE = "https://api.fiken.no/api/v2";
const MAX_GET_RETRIES = 3;
const MAX_BACKOFF_MS = 8000;
const MAX_ERROR_BODY = 1000;

function token(): string {
    const t = process.env.FIKEN_API_TOKEN;
    if (!t) throw new Error("FIKEN_API_TOKEN environment variable is required");
    return t;
}

export function slug(): string {
    const s = process.env.FIKEN_COMPANY_SLUG;
    if (!s) throw new Error("FIKEN_COMPANY_SLUG environment variable is required");
    return s;
}

/** Build a company-scoped path, e.g. cp('/invoices') → /companies/my-slug/invoices */
export function cp(path: string): string {
    return `/companies/${slug()}${path}`;
}

type Params = Record<string, string | number | boolean | undefined | null>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryBaseMs(): number {
    const n = Number(process.env.FIKEN_RETRY_BASE_MS ?? 1000);
    return Number.isFinite(n) && n >= 0 ? n : 1000;
}

function backoffMs(r: Response, attempt: number): number {
    const retryAfter = Number(r.headers.get("Retry-After"));
    const ms = retryAfter > 0 ? retryAfter * 1000 : retryBaseMs() * 2 ** attempt;
    return Math.min(ms, MAX_BACKOFF_MS);
}

async function failure(r: Response): Promise<Error> {
    const body = await r.text();
    return new Error(`Fiken ${r.status}: ${body.slice(0, MAX_ERROR_BODY)}`);
}

/**
 * Send one request through the process-wide limiter. Reads are retried on 429/503;
 * writes are never retried, because the first attempt may already have taken effect.
 */
async function send(url: URL | string, init: RequestInit, isRead: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        let r: Response;
        try {
            r = await schedule(() => fetch(url, init));
        } catch (e) {
            if (isRead) throw e;
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(
                `Fiken request failed (${reason}). A write may have completed: read back before retrying.`,
            );
        }
        const retryable = r.status === 429 || r.status === 503;
        if (!isRead || !retryable || attempt >= MAX_GET_RETRIES) return r;
        await sleep(backoffMs(r, attempt));
    }
}

async function parseMutationResponse(r: Response): Promise<unknown> {
    if (!r.ok) throw await failure(r);
    if (r.status === 204) return { success: true };
    if (r.status === 201) return { created: true, location: r.headers.get("Location") };
    try {
        return await r.json();
    } catch {
        return { success: true };
    }
}

export async function get(path: string, params?: Params): Promise<unknown> {
    const url = new URL(`${BASE}${path}`);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, String(v));
        }
    }
    const r = await send(url, { headers: { Authorization: `Bearer ${token()}` } }, true);
    if (!r.ok) throw await failure(r);
    return r.status === 204 ? null : r.json();
}

export async function mutate(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await send(
        `${BASE}${path}`,
        {
            method,
            headers: {
                Authorization: `Bearer ${token()}`,
                "Content-Type": "application/json",
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        false,
    );
    return parseMutationResponse(r);
}

export async function uploadMultipart(
    path: string,
    params: Params | undefined,
    form: FormData,
): Promise<unknown> {
    const url = new URL(`${BASE}${path}`);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, String(v));
        }
    }
    const r = await send(
        url,
        { method: "POST", headers: { Authorization: `Bearer ${token()}` }, body: form },
        false,
    );
    return parseMutationResponse(r);
}

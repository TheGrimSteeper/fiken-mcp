import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import sharp from "sharp";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
    fetchForFiken,
    filenameFromDisposition,
    maxAttachmentBytes,
    withExtension,
} from "../paperless.js";

function response(status: number, body: Buffer | string, headers: Record<string, string> = {}) {
    const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
        arrayBuffer: () =>
            Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    };
}

const pdf = (name = "kvittering.pdf", size = 10) =>
    response(200, Buffer.alloc(size, 1), {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
    });

async function noisyPng(edge: number) {
    const raw = Buffer.alloc(edge * edge * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 251;
    return sharp(raw, { raw: { width: edge, height: edge, channels: 3 } })
        .png()
        .toBuffer();
}

async function photoLikePng(edge: number) {
    const raw = Buffer.alloc(edge * edge * 3);
    for (let y = 0; y < edge; y++) {
        for (let x = 0; x < edge; x++) {
            const i = (y * edge + x) * 3;
            const n = (x * 31 + y * 17) % 13;
            raw[i] = ((x / edge) * 200 + n) | 0;
            raw[i + 1] = ((y / edge) * 200 + n) | 0;
            raw[i + 2] = (((x + y) / (2 * edge)) * 200 + n) | 0;
        }
    }
    return sharp(raw, { raw: { width: edge, height: edge, channels: 3 } })
        .png()
        .toBuffer();
}

describe("paperless", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        process.env.PAPERLESS_API_URL = "http://paperless:8000/";
        process.env.PAPERLESS_API_TOKEN = "ptoken";
        delete process.env.FIKEN_MAX_ATTACHMENT_BYTES;
    });

    afterEach(() => {
        delete process.env.PAPERLESS_API_URL;
        delete process.env.PAPERLESS_API_TOKEN;
        delete process.env.FIKEN_MAX_ATTACHMENT_BYTES;
    });

    it("downloads the original with the Paperless token", async () => {
        mockFetch.mockResolvedValue(pdf());
        const file = await fetchForFiken(42);
        expect(file).toEqual({
            bytes: Buffer.alloc(10, 1),
            contentType: "application/pdf",
            filename: "kvittering.pdf",
        });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("http://paperless:8000/api/documents/42/download/?original=true");
        expect(init.headers.Authorization).toBe("Token ptoken");
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("requires Paperless settings", async () => {
        delete process.env.PAPERLESS_API_TOKEN;
        await expect(fetchForFiken(1)).rejects.toThrow("PAPERLESS_NOT_CONFIGURED");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses the archived PDF when Fiken can't take the original type", async () => {
        mockFetch
            .mockResolvedValueOnce(
                response(200, "heic", {
                    "Content-Type": "image/heic",
                    "Content-Disposition": 'attachment; filename="IMG_1.HEIC"',
                }),
            )
            .mockResolvedValueOnce(pdf("IMG_1.pdf"));
        const file = await fetchForFiken(7);
        expect(file.filename).toBe("IMG_1.pdf");
        expect(mockFetch.mock.calls[1][0]).toBe("http://paperless:8000/api/documents/7/download/");
    });

    it("refuses documents with neither a supported original nor a PDF archive", async () => {
        mockFetch.mockResolvedValue(response(200, "x", { "Content-Type": "message/rfc822" }));
        await expect(fetchForFiken(7)).rejects.toThrow(
            "UNSUPPORTED_TYPE: Paperless has no PDF or image version of document 7 (message/rfc822)",
        );
        mockFetch.mockResolvedValue(response(200, "x"));
        await expect(fetchForFiken(7)).rejects.toThrow("(unknown type)");
    });

    it("maps Paperless errors to clear codes", async () => {
        const cases: [number, string][] = [
            [404, "PAPERLESS_NOT_FOUND"],
            [401, "PAPERLESS_ACCESS_DENIED"],
            [403, "PAPERLESS_ACCESS_DENIED"],
            [500, "PAPERLESS_DOWNLOAD_FAILED: Paperless answered 500"],
        ];
        for (const [status, code] of cases) {
            mockFetch.mockResolvedValueOnce(response(status, ""));
            await expect(fetchForFiken(3)).rejects.toThrow(code);
        }
    });

    it("refuses downloads over 50 MB", async () => {
        mockFetch.mockResolvedValue(
            response(200, Buffer.alloc(50 * 1024 * 1024 + 1), {
                "Content-Type": "application/pdf",
            }),
        );
        await expect(fetchForFiken(3)).rejects.toThrow("PAPERLESS_DOWNLOAD_TOO_LARGE");
    });

    it("names files without a Content-Disposition after the document id", async () => {
        mockFetch.mockResolvedValue(response(200, "x", { "Content-Type": "image/png" }));
        expect((await fetchForFiken(9)).filename).toBe("paperless-9.png");
    });

    it("refuses PDFs over the attachment limit", async () => {
        process.env.FIKEN_MAX_ATTACHMENT_BYTES = "5";
        mockFetch.mockResolvedValue(pdf("big.pdf", 6));
        await expect(fetchForFiken(3)).rejects.toThrow(
            "ATTACHMENT_TOO_LARGE: PDF is 6 bytes, over the 5 byte limit",
        );
    });

    it("downscales a photo over the default 4 MB limit to a 2400 px JPEG", async () => {
        const png = await photoLikePng(3000);
        expect(png.length).toBeGreaterThan(4_000_000);
        mockFetch.mockResolvedValue(
            response(200, png, {
                "Content-Type": "image/png",
                "Content-Disposition": 'attachment; filename="bilag.png"',
            }),
        );
        const file = await fetchForFiken(5);
        expect(file.contentType).toBe("image/jpeg");
        expect(file.filename).toBe("bilag.jpg");
        expect(file.bytes.length).toBeLessThanOrEqual(4_000_000);
        const meta = await sharp(file.bytes).metadata();
        expect(Math.max(meta.width!, meta.height!)).toBe(2400);
    }, 30000);

    it("steps down in size until the image fits", async () => {
        process.env.FIKEN_MAX_ATTACHMENT_BYTES = "100000";
        mockFetch.mockResolvedValue(
            response(200, await noisyPng(3000), { "Content-Type": "image/png" }),
        );
        const file = await fetchForFiken(5);
        expect(file.bytes.length).toBeLessThanOrEqual(100_000);
        const meta = await sharp(file.bytes).metadata();
        expect(Math.max(meta.width!, meta.height!)).toBe(1200);
    }, 30000);

    it("gives up when an image can't be shrunk enough", async () => {
        process.env.FIKEN_MAX_ATTACHMENT_BYTES = "100";
        mockFetch.mockResolvedValue(
            response(200, await noisyPng(400), { "Content-Type": "image/png" }),
        );
        await expect(fetchForFiken(5)).rejects.toThrow(
            "ATTACHMENT_TOO_LARGE: image is still over the size limit",
        );
    }, 30000);
});

describe("helpers", () => {
    it("reads plain and RFC 5987 filenames", () => {
        expect(filenameFromDisposition(null)).toBeUndefined();
        expect(filenameFromDisposition("inline")).toBeUndefined();
        expect(filenameFromDisposition('attachment; filename="a b.pdf"')).toBe("a b.pdf");
        expect(filenameFromDisposition("attachment; filename=plain.pdf")).toBe("plain.pdf");
        expect(
            filenameFromDisposition(
                "attachment; filename*=UTF-8''kj%C3%B8p.pdf; filename=\"x.pdf\"",
            ),
        ).toBe("kjøp.pdf");
        expect(
            filenameFromDisposition(
                "attachment; filename*=UTF-8''bad%E0; filename=\"fallback.pdf\"",
            ),
        ).toBe("fallback.pdf");
    });

    it("sets a safe extension", () => {
        expect(withExtension("IMG_1.HEIC", "pdf")).toBe("IMG_1.pdf");
        expect(withExtension("noext", "jpg")).toBe("noext.jpg");
        expect(withExtension("../etc/passwd", "pdf")).toBe(".._etc_passwd.pdf");
        expect(withExtension("  ", "pdf")).toBe("document.pdf");
    });

    it("reads the attachment limit with a safe fallback", () => {
        expect(maxAttachmentBytes()).toBe(4_000_000);
        for (const bad of ["0", "-1", "abc", "1.5"]) {
            process.env.FIKEN_MAX_ATTACHMENT_BYTES = bad;
            expect(maxAttachmentBytes()).toBe(4_000_000);
        }
        process.env.FIKEN_MAX_ATTACHMENT_BYTES = "123";
        expect(maxAttachmentBytes()).toBe(123);
        delete process.env.FIKEN_MAX_ATTACHMENT_BYTES;
    });
});

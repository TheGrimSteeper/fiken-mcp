import sharp from "sharp";

/**
 * Fetch documents from Paperless-ngx and turn them into files Fiken accepts
 * (PDF, JPEG, PNG or GIF under the attachment size limit).
 */

export interface FikenFile {
    bytes: Buffer;
    contentType: string;
    filename: string;
}

const FIKEN_TYPES: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
};

const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const RESIZE_STEPS = [2400, 1800, 1200];

function config() {
    const url = process.env.PAPERLESS_API_URL;
    const token = process.env.PAPERLESS_API_TOKEN;
    if (!url || !token) {
        throw new Error("PAPERLESS_NOT_CONFIGURED: set PAPERLESS_API_URL and PAPERLESS_API_TOKEN");
    }
    return { url: url.replace(/\/+$/, ""), token };
}

export function maxAttachmentBytes(): number {
    const n = Number(process.env.FIKEN_MAX_ATTACHMENT_BYTES ?? 4_000_000);
    return Number.isInteger(n) && n > 0 ? n : 4_000_000;
}

/** Filename from a Content-Disposition header, preferring the RFC 5987 form. */
export function filenameFromDisposition(header: string | null): string | undefined {
    if (!header) return undefined;
    const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (extended) {
        try {
            return decodeURIComponent(extended[1].trim());
        } catch {
            // Fall through to the plain form.
        }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain?.[1].trim();
}

/** Replace the extension (or add one) so Fiken accepts the filename. */
export function withExtension(name: string, ext: string): string {
    const safe = name.replace(/[\\/\0]/g, "_").trim() || "document";
    const base = safe.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    return `${base}.${ext}`;
}

async function download(id: number, original: boolean): Promise<FikenFile> {
    const { url, token } = config();
    const query = original ? "?original=true" : "";
    const r = await fetch(`${url}/api/documents/${id}/download/${query}`, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (r.status === 404)
        throw new Error(`PAPERLESS_NOT_FOUND: Paperless document ${id} does not exist`);
    if (r.status === 401 || r.status === 403) {
        throw new Error(
            "PAPERLESS_ACCESS_DENIED: check PAPERLESS_API_TOKEN and document permissions",
        );
    }
    if (!r.ok) throw new Error(`PAPERLESS_DOWNLOAD_FAILED: Paperless answered ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
        throw new Error("PAPERLESS_DOWNLOAD_TOO_LARGE: document is larger than 50 MB");
    }
    const contentType = (r.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const filename =
        filenameFromDisposition(r.headers.get("Content-Disposition")) ?? `paperless-${id}`;
    return { bytes, contentType, filename };
}

async function shrinkImage(file: FikenFile, limit: number): Promise<FikenFile> {
    for (const edge of RESIZE_STEPS) {
        const bytes = await sharp(file.bytes)
            .rotate()
            .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer();
        if (bytes.length <= limit) {
            return {
                bytes,
                contentType: "image/jpeg",
                filename: withExtension(file.filename, "jpg"),
            };
        }
    }
    throw new Error("ATTACHMENT_TOO_LARGE: image is still over the size limit after downscaling");
}

/**
 * Download a Paperless document as a file Fiken accepts. Uses the original when
 * Fiken supports its type, otherwise Paperless' archived PDF (e.g. for HEIC photos
 * or e-mails). Oversized images are downscaled; oversized PDFs are refused.
 */
export async function fetchForFiken(id: number): Promise<FikenFile> {
    let file = await download(id, true);
    if (!FIKEN_TYPES[file.contentType]) {
        file = await download(id, false);
        if (file.contentType !== "application/pdf") {
            throw new Error(
                `UNSUPPORTED_TYPE: Paperless has no PDF or image version of document ${id} (${file.contentType || "unknown type"})`,
            );
        }
    }
    file = { ...file, filename: withExtension(file.filename, FIKEN_TYPES[file.contentType]) };

    const limit = maxAttachmentBytes();
    if (file.bytes.length <= limit) return file;
    if (file.contentType === "application/pdf") {
        throw new Error(
            `ATTACHMENT_TOO_LARGE: PDF is ${file.bytes.length} bytes, over the ${limit} byte limit`,
        );
    }
    return shrinkImage(file, limit);
}

import { AttachmentKind, MemoryAttachmentInput } from './types';

/**
 * Validation for inline media attachments before they are embedded/stored.
 *
 * `gemini-embedding-2` accepts text, image, audio, video, and PDF mapped into
 * one space, with documented per-request caps (image ≤ 6, PDF 1 file/≤ 6 pages,
 * audio ≤ 180 s, video ≤ 120 s). We enforce what is cheaply detectable here —
 * the mimeType allowlist, per-modality counts, and a byte ceiling. Precise
 * audio/video duration and PDF page-count enforcement need media parsing and
 * are deferred (see issue #10 follow-ups); the conservative count caps below
 * keep a single request well within the shared 8,192-token budget meanwhile.
 */

const MIME_TO_KIND: Record<string, AttachmentKind> = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'audio/mp3': 'audio',
    'audio/mpeg': 'audio',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/wave': 'audio',
    'video/mp4': 'video',
    'video/quicktime': 'video',
    'application/pdf': 'pdf',
};

/** Every mimeType accepted as an attachment. */
export const SUPPORTED_MIME_TYPES: string[] = Object.keys(MIME_TO_KIND);

/**
 * File-extension → mimeType, for inferring an attachment's type from a local
 * path when the caller does not pass `mimeType` explicitly. Every value here is
 * one of the supported types above, so an inferred mimeType always validates.
 */
const EXT_TO_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp3': 'audio/mp3',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.qt': 'video/quicktime',
    '.pdf': 'application/pdf',
};

/** Every file extension that maps to a supported attachment mimeType. */
export const SUPPORTED_ATTACHMENT_EXTENSIONS: string[] = Object.keys(EXT_TO_MIME);

/** Infer a supported mimeType from a file path's extension, or undefined. */
export function inferMimeTypeFromPath(filePath: string): string | undefined {
    if (typeof filePath !== 'string') return undefined;
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot < 0) return undefined;
    const ext = filePath.slice(lastDot).toLowerCase();
    return EXT_TO_MIME[ext];
}

export interface AttachmentLimits {
    /** Max image attachments per memory (Gemini caps image at 6 per request). */
    maxImages: number;
    /** Max audio attachments per memory. */
    maxAudio: number;
    /** Max video attachments per memory. */
    maxVideo: number;
    /** Max PDF attachments per memory (Gemini caps documents at 1 file/request). */
    maxPdf: number;
    /** Per-attachment decoded-byte ceiling. */
    maxBytesPerAttachment: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
    maxImages: 6,
    maxAudio: 1,
    maxVideo: 1,
    maxPdf: 1,
    maxBytesPerAttachment: 20 * 1024 * 1024,
};

/** A decoded, validated attachment ready to embed + persist. */
export interface ValidatedAttachment {
    kind: AttachmentKind;
    mimeType: string;
    bytes: Buffer;
    byteLength: number;
    caption?: string;
}

/** Thrown for any caller-correctable problem with an attachments payload. */
export class AttachmentValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AttachmentValidationError';
    }
}

/** Map a mimeType to its modality, or undefined if unsupported. */
export function mimeToKind(mimeType: string): AttachmentKind | undefined {
    if (typeof mimeType !== 'string') return undefined;
    return MIME_TO_KIND[mimeType.toLowerCase()];
}

function decodeBase64(data: string): Buffer {
    // Tolerate a `data:<mime>;base64,<payload>` URL prefix from UIs.
    const payload = data.startsWith('data:') && data.includes(',')
        ? data.slice(data.indexOf(',') + 1)
        : data;
    return Buffer.from(payload, 'base64');
}

/**
 * Validate + decode an attachments array. Throws AttachmentValidationError on
 * the first problem (unsupported type, empty/oversized bytes, count over cap).
 * Returns the decoded attachments in input order.
 */
export function validateAttachments(
    attachments: MemoryAttachmentInput[],
    limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): ValidatedAttachment[] {
    const result: ValidatedAttachment[] = [];
    const counts: Record<AttachmentKind, number> = { image: 0, audio: 0, video: 0, pdf: 0 };
    const capFor: Record<AttachmentKind, number> = {
        image: limits.maxImages,
        audio: limits.maxAudio,
        video: limits.maxVideo,
        pdf: limits.maxPdf,
    };
    const labelFor: Record<AttachmentKind, string> = { image: 'image', audio: 'audio', video: 'video', pdf: 'PDF' };
    // base64 inflates bytes by ~4/3; reject oversized payloads by string length
    // BEFORE allocating the decoded Buffer so a huge input can't OOM the process.
    const maxBase64Len = Math.ceil(limits.maxBytesPerAttachment * 1.37) + 256;

    attachments.forEach((att, i) => {
        if (!att || typeof att.mimeType !== 'string' || typeof att.data !== 'string') {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} must be an object with a string 'mimeType' and base64 'data'.`,
            );
        }

        const kind = mimeToKind(att.mimeType);
        if (!kind) {
            throw new AttachmentValidationError(
                `Unsupported attachment mimeType '${att.mimeType}'. Supported: ${SUPPORTED_MIME_TYPES.join(', ')}.`,
            );
        }

        // Enforce the per-modality cap and the size ceiling before decoding, so
        // an over-cap or oversized payload never gets fully decoded into memory.
        counts[kind] += 1;
        if (counts[kind] > capFor[kind]) {
            throw new AttachmentValidationError(
                `Too many ${labelFor[kind]} attachments (${counts[kind]}); max ${capFor[kind]} per memory.`,
            );
        }
        if (att.data.length > maxBase64Len) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) exceeds the ${limits.maxBytesPerAttachment}-byte per-attachment limit.`,
            );
        }

        const bytes = decodeBase64(att.data);
        if (bytes.length === 0) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) decoded to 0 bytes; 'data' must be non-empty base64.`,
            );
        }
        if (bytes.length > limits.maxBytesPerAttachment) {
            throw new AttachmentValidationError(
                `Attachment #${i + 1} (${att.mimeType}) is ${bytes.length} bytes, over the ` +
                `${limits.maxBytesPerAttachment}-byte per-attachment limit.`,
            );
        }

        const caption = typeof att.caption === 'string' ? att.caption.trim() : '';
        result.push({
            kind,
            mimeType: att.mimeType,
            bytes,
            byteLength: bytes.length,
            ...(caption.length > 0 && { caption }),
        });
    });

    return result;
}

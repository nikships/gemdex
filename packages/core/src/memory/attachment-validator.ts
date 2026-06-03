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

        counts[kind] += 1;
        const caption = typeof att.caption === 'string' ? att.caption.trim() : '';
        result.push({
            kind,
            mimeType: att.mimeType,
            bytes,
            byteLength: bytes.length,
            ...(caption.length > 0 && { caption }),
        });
    });

    if (counts.image > limits.maxImages) {
        throw new AttachmentValidationError(`Too many image attachments (${counts.image}); max ${limits.maxImages} per memory.`);
    }
    if (counts.audio > limits.maxAudio) {
        throw new AttachmentValidationError(`Too many audio attachments (${counts.audio}); max ${limits.maxAudio} per memory.`);
    }
    if (counts.video > limits.maxVideo) {
        throw new AttachmentValidationError(`Too many video attachments (${counts.video}); max ${limits.maxVideo} per memory.`);
    }
    if (counts.pdf > limits.maxPdf) {
        throw new AttachmentValidationError(`Too many PDF attachments (${counts.pdf}); max ${limits.maxPdf} per memory.`);
    }

    return result;
}

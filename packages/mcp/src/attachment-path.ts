import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    AttachmentValidationError,
    DEFAULT_ATTACHMENT_LIMITS,
    MemoryAttachmentInput,
    SUPPORTED_ATTACHMENT_EXTENSIONS,
    inferMimeTypeFromPath,
} from "gemdex-core";

/**
 * MCP-only attachment input: either inline base64 (`data`) — the original
 * contract — or a local file `path` the server reads off disk. Agents prefer
 * `path`: it sidesteps emitting megabytes of base64 in tool-call arguments.
 */
export interface AttachmentPathInput {
    mimeType?: string;
    /** base64-encoded bytes. Mutually exclusive with `path`. */
    data?: string;
    /** Local file path. Mutually exclusive with `data`. */
    path?: string;
    caption?: string;
}

/** Expand a leading `~`, strip a `file://` URL, and resolve against cwd. */
function normalizePath(raw: string): string {
    if (raw.startsWith("file://")) {
        return fileURLToPath(raw);
    }
    let p = raw;
    if (p === "~" || p.startsWith("~/")) {
        p = path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(p);
}

/** Read one path-backed attachment off disk into a base64 `data` input. */
async function resolveOne(att: AttachmentPathInput, index: number): Promise<MemoryAttachmentInput> {
    const hasData = typeof att.data === "string" && att.data.length > 0;
    const hasPath = typeof att.path === "string" && att.path.length > 0;

    if (hasData && hasPath) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1} must have exactly one of 'data' or 'path', not both.`,
        );
    }

    // No path: pass through unchanged. validateAttachments enforces data/mimeType.
    if (!hasPath) {
        return {
            ...(att.mimeType !== undefined && { mimeType: att.mimeType }),
            ...(att.data !== undefined && { data: att.data }),
            ...(att.caption !== undefined && { caption: att.caption }),
        } as MemoryAttachmentInput;
    }

    const resolved = normalizePath(att.path as string);

    let stat: import("fs").Stats;
    try {
        stat = await fs.stat(resolved);
    } catch {
        throw new AttachmentValidationError(
            `Attachment #${index + 1}: file not found at '${resolved}'.`,
        );
    }
    if (!stat.isFile()) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1}: '${resolved}' is not a file.`,
        );
    }
    // Size-guard via stat BEFORE reading, so an oversized file never loads into memory.
    if (stat.size > DEFAULT_ATTACHMENT_LIMITS.maxBytesPerAttachment) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1}: '${resolved}' is ${stat.size} bytes, over the ` +
            `${DEFAULT_ATTACHMENT_LIMITS.maxBytesPerAttachment}-byte per-attachment limit.`,
        );
    }

    const mimeType = att.mimeType ?? inferMimeTypeFromPath(resolved);
    if (!mimeType) {
        throw new AttachmentValidationError(
            `Attachment #${index + 1}: could not infer mimeType from '${resolved}'. ` +
            `Pass 'mimeType' explicitly, or use a supported extension: ${SUPPORTED_ATTACHMENT_EXTENSIONS.join(", ")}.`,
        );
    }

    const bytes = await fs.readFile(resolved);
    return {
        mimeType,
        data: bytes.toString("base64"),
        ...(att.caption !== undefined && { caption: att.caption }),
    };
}

/**
 * Resolve an MCP `attachments` array into the core `MemoryAttachmentInput[]`
 * shape: items carrying a local `path` are read off disk and base64-encoded
 * here (with mimeType inferred from the extension when not given); items
 * carrying inline `data` pass through untouched. Throws AttachmentValidationError
 * on any path problem; the caller surfaces the message to the agent.
 */
export async function resolveAttachmentInputs(
    attachments: AttachmentPathInput[],
): Promise<MemoryAttachmentInput[]> {
    const out: MemoryAttachmentInput[] = [];
    for (let i = 0; i < attachments.length; i++) {
        out.push(await resolveOne(attachments[i], i));
    }
    return out;
}

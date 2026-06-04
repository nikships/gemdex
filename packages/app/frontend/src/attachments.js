/**
 * Pure attachment helpers shared by the editor UI and unit tests.
 *
 * Nothing in here touches the DOM, the network, or module-scoped UI state — it
 * is all deterministic over its arguments so it can be exercised directly by
 * vitest. `main.js` re-imports these so runtime behavior is unchanged.
 */

// Mirror of packages/core/src/memory/attachment-validator.ts so the UI gives
// instant feedback; the sidecar remains the source of truth on save.
export const MIME_TO_KIND = {
  "image/png": "image",
  "image/jpeg": "image",
  "audio/mp3": "audio",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/wave": "audio",
  "video/mp4": "video",
  "video/quicktime": "video",
  "application/pdf": "pdf",
};
export const KIND_CAPS = { image: 6, audio: 1, video: 1, pdf: 1 };
export const MAX_BYTES_PER_ATTACHMENT = 20 * 1024 * 1024;

export function kindFromMime(mimeType) {
  return MIME_TO_KIND[(mimeType || "").toLowerCase()];
}

export function humanSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// Existing attachments are keyed by their server id; freshly-added files have
// no id yet, so they key by filename. Shared by both signature builders.
function entryId(a) {
  return a.source === "existing" ? a.id : a.file.name;
}

/**
 * A stable signature of the editor attachment set, to detect edits. JSON
 * serialization (rather than delimiter joining) so captions or filenames
 * containing ":" or "|" can't collide and silently defeat the caption-only
 * fast path.
 */
export function attachmentSignature(items) {
  return JSON.stringify(
    items.map((a) => ({
      source: a.source,
      id: entryId(a),
      caption: a.caption || "",
    })),
  );
}

/**
 * Like attachmentSignature, but caption-free: it captures only the structural
 * identity of the set (source + id/filename, in order). Two sets with the same
 * structure signature differ at most in captions.
 */
export function attachmentStructureSignature(items) {
  return JSON.stringify(
    items.map((a) => ({
      source: a.source,
      id: entryId(a),
    })),
  );
}

/**
 * Recover the structure signature from a full (caption-bearing) signature by
 * dropping each entry's caption. Mirrors how attachmentSignature builds its
 * entries.
 */
function structureFromSignature(sig) {
  if (!sig) return "[]";
  try {
    return JSON.stringify(
      JSON.parse(sig).map((entry) => ({ source: entry.source, id: entry.id })),
    );
  } catch (_) {
    return "[]";
  }
}

/**
 * Classify how the open editor's attachment set differs from the set that was
 * loaded for the memory (represented by its signature):
 *   - "none"         identical — no media work needed on save.
 *   - "caption-only" same existing attachments, only captions changed — eligible
 *                    for the PATCH /memories/:id/attachments fast path (no
 *                    re-embed).
 *   - "structural"   adds, removes, reorders, or new-source files — requires the
 *                    full PUT that replaces (and re-embeds) all media.
 */
export function classifyAttachmentChange(editorAttachments, loadedAttachmentSig) {
  // A new memory / never-loaded set is "" here; normalize to the empty-set
  // JSON signature so the comparisons below stay format-consistent.
  const loadedSig = loadedAttachmentSig || "[]";
  const currentSig = attachmentSignature(editorAttachments);
  if (currentSig === loadedSig) return "none";
  // Any freshly-added file means the media set itself changed.
  if (editorAttachments.some((a) => a.source !== "existing")) return "structural";
  // All existing: caption-only iff the structure is unchanged.
  const sameStructure =
    attachmentStructureSignature(editorAttachments) === structureFromSignature(loadedSig);
  return sameStructure ? "caption-only" : "structural";
}

/**
 * Build the PATCH body's caption list from the editor set. Only existing
 * attachments carry ids; captions are trimmed and an empty string clears.
 */
export function captionPatchFromAttachments(editorAttachments) {
  return editorAttachments
    .filter((a) => a.source === "existing")
    .map((a) => ({ id: a.id, caption: (a.caption ?? "").trim() }));
}

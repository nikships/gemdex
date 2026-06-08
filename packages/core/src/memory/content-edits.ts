/**
 * Find-and-replace edits for memory content.
 *
 * Lets a caller change part of a memory by sending only the changed snippets
 * instead of re-emitting the whole note. The MCP `update_memory` tool applies
 * these client-side against the current content, then persists the result via
 * the normal full-content update path — so no edit semantics leak into the
 * storage layer or the HTTP contract.
 *
 * Semantics mirror the familiar str-replace / MultiEdit editing tools.
 */

/** One literal find-and-replace against memory content. */
export interface ContentEdit {
    /** Exact substring to find. Matched literally (no regex). Must be non-empty. */
    oldText: string;
    /** Replacement text. Must differ from `oldText`. */
    newText: string;
    /** Replace every occurrence. When false/omitted, `oldText` must be unique. */
    replaceAll?: boolean;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let from = 0;
    for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        count += 1;
        // Advance past this match so occurrences are non-overlapping, matching
        // JavaScript's String.replace/replaceAll behavior (e.g. "aa" in "aaa"
        // matches once).
        from = index + needle.length;
    }
    return count;
}

/** Replace the first occurrence of `oldText` with `newText`. */
function replaceFirst(content: string, oldText: string, newText: string): string {
    const index = content.indexOf(oldText);
    return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

/** A short, log-safe preview of an edit's target text for error messages. */
function preview(text: string, max = 60): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= max) return collapsed;
    return collapsed.slice(0, max) + '…';
}

/**
 * Apply a sequence of literal find-and-replace edits to `content`, returning
 * the new content. Edits are applied in order, each against the result of the
 * previous one. Occurrences are non-overlapping (as in String.replaceAll).
 *
 * Throws on: an empty edit list, an empty `oldText`, an `oldText` identical to
 * its `newText`, a missing `oldText`, or a non-unique `oldText` without
 * `replaceAll`.
 */
export function applyContentEdits(content: string, edits: ContentEdit[]): string {
    if (edits.length === 0) {
        throw new Error('at least one edit is required');
    }
    let result = content;
    for (const edit of edits) {
        const { oldText, newText } = edit;
        if (oldText.length === 0) {
            throw new Error("'oldText' must not be empty");
        }
        if (oldText === newText) {
            throw new Error("'oldText' and 'newText' are identical; no change to apply");
        }
        const occurrences = countOccurrences(result, oldText);
        if (occurrences === 0) {
            throw new Error(`oldText not found in memory content: "${preview(oldText)}"`);
        }
        if (occurrences > 1 && !edit.replaceAll) {
            throw new Error(
                `oldText is not unique (${occurrences} matches); add surrounding context or set replaceAll: true: "${preview(oldText)}"`,
            );
        }
        result = edit.replaceAll
            ? result.split(oldText).join(newText)
            : replaceFirst(result, oldText, newText);
    }
    return result;
}

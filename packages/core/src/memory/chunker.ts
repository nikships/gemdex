/**
 * Memory chunking for the parent-document retrieval pattern.
 *
 * A memory's `content` is split into retrieval chunks. Each chunk is embedded
 * and stored separately so that any sub-topic inside a long playbook can
 * trigger a precise hit, but recall always resolves a matching chunk back to
 * its full parent memory (see MemoryStore). Short memories are a single chunk.
 */

export interface ChunkOptions {
    /** Target maximum characters per chunk. */
    chunkSize?: number;
    /** Characters of overlap carried between adjacent chunks. */
    chunkOverlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 1500;
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Split memory content into retrieval chunks.
 *
 * Strategy: greedily fill a character window, but prefer to break on a
 * paragraph (\n\n) or line (\n) boundary in the back half of the window so
 * chunks stay semantically coherent. Adjacent chunks overlap by `chunkOverlap`
 * characters so a concept straddling a boundary is still discoverable.
 */
export function chunkMemory(content: string, options: ChunkOptions = {}): string[] {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const text = content ?? '';

    // Short memories (the common case) are a single chunk.
    if (text.length <= chunkSize) {
        return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);

        if (end < text.length) {
            const window = text.slice(start, end);
            const paragraphBreak = window.lastIndexOf('\n\n');
            const lineBreak = window.lastIndexOf('\n');
            const breakAt = paragraphBreak >= 0 ? paragraphBreak : lineBreak;
            // Only honor the break if it lands in the back half of the window,
            // otherwise we'd produce tiny chunks.
            if (breakAt > chunkSize * 0.5) {
                end = start + breakAt + 1;
            }
        }

        chunks.push(text.slice(start, end));

        if (end >= text.length) break;
        // Step forward, retaining `chunkOverlap` chars of context.
        start = Math.max(end - chunkOverlap, start + 1);
    }

    return chunks;
}

/**
 * Derive a short display title from a memory's content when the user/agent did
 * not supply one. Uses the first non-empty line, stripped of leading markdown
 * heading markers and list bullets, truncated for list display.
 */
export function deriveTitle(content: string, maxLength = 80): string {
    const firstLine = (content ?? '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    if (!firstLine) {
        return 'Untitled memory';
    }

    const cleaned = firstLine.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
    if (cleaned.length <= maxLength) {
        return cleaned;
    }
    return cleaned.slice(0, maxLength - 1).trimEnd() + '…';
}

import { MemoryBackend, applyContentEdits, ContentEdit } from "gemdex-core";
import { resolveAttachmentInputs } from "./attachment-path.js";
import { errorMessage } from "./errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
    return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

/**
 * Validate the optional `attachments` argument shared by all three tools.
 * Returns the array (or undefined when absent), or an error ToolResult to
 * surface to the agent when it is present but not an array.
 */
type ParsedAttachments = { attachments?: any[] } | { error: ToolResult };

function parseAttachments(value: unknown): ParsedAttachments {
    if (value === undefined) return {};
    if (!Array.isArray(value)) {
        return { error: textResult("Error: 'attachments' must be an array.", true) };
    }
    return { attachments: value };
}

/**
 * Validate the optional `edits` argument of update_memory. Returns the typed
 * edit list (or undefined when absent), or an error ToolResult when the shape
 * is wrong. Find-and-replace semantics themselves are enforced later by
 * `applyContentEdits`.
 */
type ParsedEdits = { edits?: ContentEdit[] } | { error: ToolResult };

function parseEdits(value: unknown): ParsedEdits {
    if (value === undefined) return {};
    if (!Array.isArray(value)) {
        return { error: textResult("Error: 'edits' must be an array.", true) };
    }
    if (value.length === 0) {
        return { error: textResult("Error: 'edits' must contain at least one edit.", true) };
    }
    const edits: ContentEdit[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            return { error: textResult("Error: each edit must be an object with 'oldText' and 'newText'.", true) };
        }
        const { oldText, newText, replaceAll } = item as Record<string, unknown>;
        if (typeof oldText !== 'string' || typeof newText !== 'string') {
            return { error: textResult("Error: each edit requires string 'oldText' and 'newText'.", true) };
        }
        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
            return { error: textResult("Error: 'replaceAll' must be a boolean when provided.", true) };
        }
        edits.push({ oldText, newText, ...(replaceAll !== undefined && { replaceAll }) });
    }
    return { edits };
}

/** Render one fused-search branch, e.g. `dense=#3 (d=0.1234)` or `bm25=—`. */
function formatScoreBranch(label: string, rank: number | undefined, detail: string): string {
    if (rank === undefined) return `${label}=—`;
    return `${label}=#${rank}${detail}`;
}

/**
 * Render the per-branch sub-score line shown beneath each recall hit so the
 * agent can gauge confidence (mirrors the old code-search format).
 */
function formatSubScoresLine(fusedScore: number, subScores?: {
    denseRank?: number;
    denseDistance?: number;
    ftsRank?: number;
    ftsScore?: number;
}): string {
    const fused = `fused=${fusedScore.toFixed(4)}`;
    if (!subScores) return `Scores: ${fused}`;
    const denseDetail = subScores.denseDistance !== undefined ? ` (d=${subScores.denseDistance.toFixed(4)})` : '';
    const ftsDetail = subScores.ftsScore !== undefined ? ` (s=${subScores.ftsScore.toFixed(2)})` : '';
    const dense = formatScoreBranch('dense', subScores.denseRank, denseDetail);
    const bm25 = formatScoreBranch('bm25', subScores.ftsRank, ftsDetail);
    return `Scores: ${fused} · ${dense} · ${bm25}`;
}

/** Render the confirmation block returned to the agent after a save/update. */
function formatMemoryResult(verb: string, memory: { id: string; title: string; attachments?: { id: string }[] }): string {
    const lines = [`${verb} memory.`, `id: ${memory.id}`, `title: ${memory.title}`];
    const count = memory.attachments?.length ?? 0;
    if (count > 0) lines.push(`attachments: ${count}`);
    return lines.join('\n');
}

export class MemoryToolHandlers {
    private store: MemoryBackend;

    constructor(store: MemoryBackend) {
        this.store = store;
    }

    async handleSaveMemory(args: any): Promise<ToolResult> {
        const content = typeof args?.content === 'string' ? args.content : '';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        const parsed = parseAttachments(args?.attachments);
        if ('error' in parsed) return parsed.error;
        const attachments = parsed.attachments;
        const hasAttachments = (attachments?.length ?? 0) > 0;
        if (content.trim().length === 0 && !hasAttachments) {
            return textResult("Error: provide 'content' or at least one attachment.", true);
        }
        try {
            const resolved = attachments && await resolveAttachmentInputs(attachments);
            const memory = await this.store.save({ content, title, ...(resolved && { attachments: resolved }) });
            return textResult(formatMemoryResult('Saved', memory));
        } catch (error) {
            return textResult(`Failed to save memory: ${errorMessage(error)}`, true);
        }
    }

    async handleRecall(args: any): Promise<ToolResult> {
        const query = typeof args?.query === 'string' ? args.query : '';
        const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 10;
        const parsed = parseAttachments(args?.attachments);
        if ('error' in parsed) return parsed.error;
        const attachments = parsed.attachments;
        const hasAttachments = (attachments?.length ?? 0) > 0;
        if (query.trim().length === 0 && !hasAttachments) {
            return textResult("Error: provide 'query' or at least one attachment.", true);
        }
        const label = query.trim().length > 0 ? `"${query}"` : 'the supplied media';
        try {
            const resolved = hasAttachments ? await resolveAttachmentInputs(attachments!) : undefined;
            const results = await this.store.recall(query, limit, resolved);
            if (results.length === 0) {
                return textResult(`No memories matched ${label}. Nothing stored yet, or no relevant match.`);
            }
            const blocks = results.map((r, i) => {
                const scoreLine = formatSubScoresLine(r.score, r.subScores);
                return [
                    `### ${i + 1}. ${r.title}`,
                    `id: ${r.id}`,
                    scoreLine,
                    ``,
                    r.content,
                ].join('\n');
            });
            const header = `Recalled ${results.length} ${results.length === 1 ? 'memory' : 'memories'} for ${label}:\n`;
            return textResult(header + '\n' + blocks.join('\n\n---\n\n'));
        } catch (error) {
            return textResult(`Failed to recall memories: ${errorMessage(error)}`, true);
        }
    }

    async handleUpdateMemory(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id : '';
        if (id.trim().length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        const hasContent = typeof args?.content === 'string';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        const parsed = parseAttachments(args?.attachments);
        if ('error' in parsed) return parsed.error;
        const attachments = parsed.attachments;
        const parsedEdits = parseEdits(args?.edits);
        if ('error' in parsedEdits) return parsedEdits.error;
        const edits = parsedEdits.edits;
        if (hasContent && edits !== undefined) {
            return textResult("Error: provide either 'content' or 'edits', not both.", true);
        }
        if (!hasContent && edits === undefined && title === undefined && attachments === undefined) {
            return textResult("Error: provide at least one of 'content', 'edits', 'title', or 'attachments' to update.", true);
        }
        // Only include provided fields so the store preserves the rest in place.
        const input: { content?: string; title?: string; attachments?: any[] } = {};
        if (hasContent) input.content = args.content;
        if (title !== undefined) input.title = title;
        try {
            // `edits` are applied client-side against the current content, then
            // persisted via the normal full-content update path. The agent only
            // emits the changed snippets — no need to resend a whole large note.
            // Note: read-modify-write is last-write-wins; a concurrent edit
            // between this fetch and the update is overwritten.
            if (edits !== undefined) {
                const current = await this.store.get(id);
                if (!current) {
                    return textResult(`Failed to update memory: Memory not found: ${id}`, true);
                }
                input.content = applyContentEdits(current.content, edits);
            }
            if (attachments !== undefined) input.attachments = await resolveAttachmentInputs(attachments);
            const memory = await this.store.update(id, input);
            return textResult(formatMemoryResult('Updated', memory));
        } catch (error) {
            return textResult(`Failed to update memory: ${errorMessage(error)}`, true);
        }
    }
}

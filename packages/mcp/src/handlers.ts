import { MemoryBackend } from "gemdex-core";
import { resolveAttachmentInputs } from "./attachment-path.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
    return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
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
    const dense = subScores.denseRank !== undefined
        ? `dense=#${subScores.denseRank}${subScores.denseDistance !== undefined ? ` (d=${subScores.denseDistance.toFixed(4)})` : ''}`
        : 'dense=—';
    const bm25 = subScores.ftsRank !== undefined
        ? `bm25=#${subScores.ftsRank}${subScores.ftsScore !== undefined ? ` (s=${subScores.ftsScore.toFixed(2)})` : ''}`
        : 'bm25=—';
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
        let attachments: any[] | undefined;
        if (args?.attachments !== undefined) {
            if (!Array.isArray(args.attachments)) {
                return textResult("Error: 'attachments' must be an array.", true);
            }
            attachments = args.attachments;
        }
        const hasAttachments = (attachments?.length ?? 0) > 0;
        if (content.trim().length === 0 && !hasAttachments) {
            return textResult("Error: provide 'content' or at least one attachment.", true);
        }
        try {
            const resolved = attachments && await resolveAttachmentInputs(attachments);
            const memory = await this.store.save({ content, title, ...(resolved && { attachments: resolved }) });
            return textResult(formatMemoryResult('Saved', memory));
        } catch (error: any) {
            return textResult(`Failed to save memory: ${error?.message ?? String(error)}`, true);
        }
    }

    async handleRecall(args: any): Promise<ToolResult> {
        const query = typeof args?.query === 'string' ? args.query : '';
        const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 10;
        let attachments: any[] | undefined;
        if (args?.attachments !== undefined) {
            if (!Array.isArray(args.attachments)) {
                return textResult("Error: 'attachments' must be an array.", true);
            }
            attachments = args.attachments;
        }
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
        } catch (error: any) {
            return textResult(`Failed to recall memories: ${error?.message ?? String(error)}`, true);
        }
    }

    async handleUpdateMemory(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id : '';
        if (id.trim().length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        const hasContent = typeof args?.content === 'string';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        let attachments: any[] | undefined;
        if (args?.attachments !== undefined) {
            if (!Array.isArray(args.attachments)) {
                return textResult("Error: 'attachments' must be an array.", true);
            }
            attachments = args.attachments;
        }
        if (!hasContent && title === undefined && attachments === undefined) {
            return textResult("Error: provide at least one of 'content', 'title', or 'attachments' to update.", true);
        }
        // Only include provided fields so the store preserves the rest in place.
        const input: { content?: string; title?: string; attachments?: any[] } = {};
        if (hasContent) input.content = args.content;
        if (title !== undefined) input.title = title;
        try {
            if (attachments !== undefined) input.attachments = await resolveAttachmentInputs(attachments);
            const memory = await this.store.update(id, input);
            return textResult(formatMemoryResult('Updated', memory));
        } catch (error: any) {
            return textResult(`Failed to update memory: ${error?.message ?? String(error)}`, true);
        }
    }
}

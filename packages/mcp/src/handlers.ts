import { MemoryStore } from "gemdex-core";

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

export class MemoryToolHandlers {
    private store: MemoryStore;

    constructor(store: MemoryStore) {
        this.store = store;
    }

    async handleSaveMemory(args: any): Promise<ToolResult> {
        const content = typeof args?.content === 'string' ? args.content : '';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        if (content.trim().length === 0) {
            return textResult("Error: 'content' is required and cannot be empty.", true);
        }
        try {
            const memory = await this.store.save({ content, title });
            return textResult(
                `Saved memory.\nid: ${memory.id}\ntitle: ${memory.title}`,
            );
        } catch (error: any) {
            return textResult(`Failed to save memory: ${error?.message ?? String(error)}`, true);
        }
    }

    async handleRecall(args: any): Promise<ToolResult> {
        const query = typeof args?.query === 'string' ? args.query : '';
        const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 10;
        if (query.trim().length === 0) {
            return textResult("Error: 'query' is required.", true);
        }
        try {
            const results = await this.store.recall(query, limit);
            if (results.length === 0) {
                return textResult(`No memories matched "${query}". Nothing stored yet, or no relevant match.`);
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
            const header = `Recalled ${results.length} ${results.length === 1 ? 'memory' : 'memories'} for "${query}":\n`;
            return textResult(header + '\n' + blocks.join('\n\n---\n\n'));
        } catch (error: any) {
            return textResult(`Failed to recall memories: ${error?.message ?? String(error)}`, true);
        }
    }

    async handleUpdateMemory(args: any): Promise<ToolResult> {
        const id = typeof args?.id === 'string' ? args.id : '';
        const content = typeof args?.content === 'string' ? args.content : '';
        const title = typeof args?.title === 'string' ? args.title : undefined;
        if (id.trim().length === 0) {
            return textResult("Error: 'id' is required.", true);
        }
        if (content.trim().length === 0) {
            return textResult("Error: 'content' is required and cannot be empty.", true);
        }
        try {
            const memory = await this.store.update(id, { content, title });
            return textResult(
                `Updated memory.\nid: ${memory.id}\ntitle: ${memory.title}`,
            );
        } catch (error: any) {
            return textResult(`Failed to update memory: ${error?.message ?? String(error)}`, true);
        }
    }
}

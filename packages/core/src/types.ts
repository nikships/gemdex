import { HybridSubScores } from './vectordb';

export interface SearchQuery {
    term: string;
    includeContent?: boolean;
    limit?: number;
}

export interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    /** Per-branch rank/score breakdown when produced by hybrid search. */
    subScores?: HybridSubScores;
    metadata?: Record<string, any>;
}

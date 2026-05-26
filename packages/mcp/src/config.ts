import { envManager } from "gemdex-core";

export interface ContextMcpConfig {
    name: string;
    version: string;
    embeddingModel: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    milvusAddress?: string;
    milvusToken?: string;
    collectionNameOverride?: string;
}

export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;
    lastUpdated: string;
}

export type RequestSplitterType = 'ast' | 'langchain';

export interface CodebaseIndexOptions {
    requestSplitter?: RequestSplitterType;
    requestCustomExtensions?: string[];
    requestIgnorePatterns?: string[];
}

interface CodebaseInfoBase extends CodebaseIndexOptions {
    lastUpdated: string;
}

export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;
}

export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;
    totalChunks: number;
    indexStatus: 'completed' | 'limit_reached';
}

export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;
    lastAttemptedPercentage?: number;
}

export type CodebaseInfo = CodebaseInfoIndexing | CodebaseInfoIndexed | CodebaseInfoIndexFailed;

export interface CodebaseSnapshotV2 {
    formatVersion: 'v2';
    codebases: Record<string, CodebaseInfo>;
    lastUpdated: string;
}

export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2;

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2';

export function getEmbeddingModel(): string {
    return envManager.get('EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL;
}

export function createMcpConfig(): ContextMcpConfig {
    console.log(`[DEBUG] 🔍 Environment Variables:`);
    console.log(`[DEBUG]   EMBEDDING_MODEL: ${envManager.get('EMBEDDING_MODEL') || `NOT SET (default: ${DEFAULT_EMBEDDING_MODEL})`}`);
    console.log(`[DEBUG]   GEMINI_API_KEY: ${envManager.get('GEMINI_API_KEY') ? 'SET' : 'NOT SET'}`);
    console.log(`[DEBUG]   MILVUS_ADDRESS: ${envManager.get('MILVUS_ADDRESS') || 'NOT SET'}`);

    return {
        name: envManager.get('MCP_SERVER_NAME') || "Context MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
        embeddingModel: getEmbeddingModel(),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        milvusAddress: envManager.get('MILVUS_ADDRESS'),
        milvusToken: envManager.get('MILVUS_TOKEN'),
        collectionNameOverride: envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE'),
    };
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    console.log(`[MCP] 🚀 Starting Context MCP Server`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding: Gemini / ${config.embeddingModel}`);
    console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
    if (config.geminiBaseUrl) console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
    console.log(`[MCP]   Milvus Address: ${config.milvusAddress || '[Not configured]'}`);
    if (config.collectionNameOverride) console.log(`[MCP]   Collection Name Override: ${config.collectionNameOverride}`);
}

export function showHelpMessage(): void {
    console.log(`
Context MCP Server (Gemini-only fork)

Usage: npx gemdex-mcp@latest [options]

Required environment variables:
  GEMINI_API_KEY          Google AI API key

Optional:
  EMBEDDING_MODEL         Gemini model name (default: gemini-embedding-2)
                          Supported: gemini-embedding-2, gemini-embedding-001
  GEMINI_BASE_URL         Custom Gemini base URL
  INDEX_MULTIMODAL        true|false (default: false). Enables PDF/image indexing with gemini-embedding-2.
  MILVUS_ADDRESS          Milvus host:port (e.g. localhost:19530)
  MILVUS_TOKEN            Milvus auth token (optional; for Milvus instances with auth enabled)
  CODE_CHUNKS_COLLECTION_NAME_OVERRIDE
                          Readable prefix for Milvus collection names.

  Background sync:
  GEMDEX_BACKGROUND_SYNC   true|false (default: true)
  GEMDEX_SYNC_INTERVAL_MS  poll interval ms (default: 300000)
  GEMDEX_TRIGGER_WATCHER   true|false (default: true)
        `);
}

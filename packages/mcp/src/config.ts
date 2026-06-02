import { envManager } from "gemdex-core";

export interface GemdexConfig {
    name: string;
    version: string;
    embeddingModel: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    lancedbPath?: string;
}

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2';

export function getEmbeddingModel(): string {
    return envManager.get('EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL;
}

export function createConfig(): GemdexConfig {
    return {
        name: envManager.get('MCP_SERVER_NAME') || "Gemdex Memory MCP",
        version: envManager.get('MCP_SERVER_VERSION') || "0.3.0",
        embeddingModel: getEmbeddingModel(),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        lancedbPath: envManager.get('LANCEDB_PATH'),
    };
}

export function logConfigurationSummary(config: GemdexConfig): void {
    console.log(`[MCP] 🧠 Starting Gemdex Memory MCP Server`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding: Gemini / ${config.embeddingModel}`);
    console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
    if (config.geminiBaseUrl) console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
    console.log(`[MCP]   LanceDB Path: ${config.lancedbPath || '[default: ~/.gemdex/lance]'}`);
}

export function showHelpMessage(): void {
    console.log(`
Gemdex — memory layer for AI coding agents (Gemini embeddings + LanceDB)

Usage:
  npx gemdex-mcp@latest            Start the MCP server (stdio) exposing
                                   save_memory, recall, update_memory.
  npx gemdex serve [--port N]      Start the localhost HTTP sidecar that backs
                                   the desktop manager app. --port 0 picks a
                                   free port.

Required environment variables:
  GEMINI_API_KEY          Google AI API key (needed to embed on save/recall/update).

Optional:
  EMBEDDING_MODEL         Gemini model name (default: gemini-embedding-2).
                          Supported: gemini-embedding-2, gemini-embedding-001.
  EMBEDDING_DIMENSION     Override the embedding output dimension.
  GEMINI_BASE_URL         Custom Gemini base URL.
  HYBRID_MODE             true|false (default: true). false = dense-only recall.
  LANCEDB_PATH            Filesystem path for the embedded LanceDB store
                          (default: ~/.gemdex/lance). Holds the single global
                          memory store.
  GEMDEX_SERVE_PORT       Default port for 'gemdex serve' (default: auto/0).
        `);
}

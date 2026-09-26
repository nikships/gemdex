import { createRequire } from "node:module";
import { envManager } from "gemdex-core";

// Read the version from this package's package.json so it never drifts from the
// published version. createRequire resolves relative to this module
// (dist/config.js → ../package.json, and src/config.ts under tsx).
const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json") as { version: string };

export type EnvGetter = (name: string) => string | undefined;

export interface GemdexConfig {
    name: string;
    version: string;
    lancedbPath?: string;
}

const defaultEnvGetter: EnvGetter = (name: string) => envManager.get(name);

export function createConfig(getEnv: EnvGetter = defaultEnvGetter): GemdexConfig {
    return {
        name: getEnv('MCP_SERVER_NAME') || "Gemdex Memory MCP",
        version: getEnv('MCP_SERVER_VERSION') || PACKAGE_VERSION,
        lancedbPath: getEnv('LANCEDB_PATH'),
    };
}

export function logConfigurationSummary(config: GemdexConfig): void {
    console.log(`[MCP] 🧠 Starting Gemdex Memory MCP Server`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding: local BGE-M3 (MLX)`);
    console.log(`[MCP]   LanceDB Path: ${config.lancedbPath || '[default: ~/.gemdex/lance]'}`);
}

export function showHelpMessage(): void {
    console.log(`
Gemdex — local memory layer for AI coding agents (on-device BGE-M3 embeddings + LanceDB)

Usage:
  npx gemdex-mcp install           Install the managed BGE-M3 MLX runtime and model
                                   (Apple Silicon only; explicit ~600 MB download).
  npx gemdex-mcp migrate           Re-embed memories saved by earlier Gemini-based
                                   releases into the local model.
  npx gemdex-mcp status            Show local model, Claude Code and store status.
  npx gemdex-mcp@latest            Start the MCP server (stdio) exposing save_memory,
                                   recall, get_memory, update_memory, report_outcome,
                                   read_attachment and delete_memory.
  npx gemdex serve [--port N]      Start the localhost HTTP sidecar that backs the
                                   desktop manager app. --port 0 picks a free port.
  npx gemdex ingest-history [--source claude|factory|codex|antigravity|PATH]... [--dry-run]
                                   Distill coding-agent chat history (Claude Code /
                                   Factory CLI / Codex / Antigravity) into one
                                   searchable memory per session. Digests are written
                                   by your local Claude Code CLI (claude -p, Haiku).
                                   --dry-run shows the scan + cost estimate.
  npx gemdex backfill-transcripts [--force] [--dry-run]
                                   Attach full transcripts to digests that only have
                                   a path footer.

Optional:
  GEMDEX_CLAUDE_PATH      Path to the claude binary used for ingestion and hygiene
                          (default: ~/.local/bin/claude, then PATH).
  HYBRID_MODE             true|false (default: true). false = dense-only recall.
  LANCEDB_PATH            Filesystem path for the embedded LanceDB store
                          (default: ~/.gemdex/lance).
  GEMDEX_SERVE_PORT       Default port for 'gemdex serve' (default: auto/0).
        `);
}

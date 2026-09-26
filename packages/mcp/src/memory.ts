import {
    LanceDBVectorDatabase,
    LEGACY_GEMINI_COLLECTION,
    LocalMemoryBackend,
    MlxEmbedding,
    getMlxStatus,
} from "gemdex-core";
import { GemdexConfig } from "./config.js";

export const INSTALL_HINT = 'Local model is not installed. Run npx gemdex-mcp install on an Apple Silicon Mac.';

/**
 * Build the local MemoryBackend over the shared embedded LanceDB store
 * (~/.gemdex/lance by default). Both the MCP server and the `gemdex serve`
 * sidecar use this so a memory saved by the agent shows up in the app and
 * vice-versa. Memories written by earlier Gemini-embedded releases stay
 * readable through the legacy collection until `gemdex migrate` moves them.
 */
export function createMemoryBackend(config: GemdexConfig, localHomeDir?: string): LocalMemoryBackend {
    if (!getMlxStatus(localHomeDir).installed) {
        throw new Error(INSTALL_HINT);
    }
    const vectorDatabase = new LanceDBVectorDatabase({
        ...(config.lancedbPath && { uri: config.lancedbPath }),
    });
    return new LocalMemoryBackend({
        embedding: new MlxEmbedding({ homeDir: localHomeDir }),
        vectorDatabase,
        legacyCollectionName: LEGACY_GEMINI_COLLECTION,
    });
}

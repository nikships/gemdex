import { getMlxStatus, installMlxModel } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig } from './config.js';
import { createMemoryBackend } from './memory.js';

export interface LocalModelStatus {
    installed: boolean;
    model: string;
    status: 'not-installed' | 'installed' | 'installing' | 'migrating' | 'error';
    /** Memories still in the legacy Gemini index; present once the model is installed. */
    legacyMemories?: number;
    message?: string;
    completed?: number;
    total?: number;
}

export function localModelStatus(store = new ClientConfigStore()): LocalModelStatus {
    const runtime = getMlxStatus(store.rootDir);
    return {
        installed: runtime.installed,
        model: runtime.model,
        status: runtime.installed ? 'installed' : 'not-installed',
    };
}

/** {@link localModelStatus} plus the legacy-index count, which needs the store. */
export async function localModelStatusWithLegacy(store = new ClientConfigStore()): Promise<LocalModelStatus> {
    const status = localModelStatus(store);
    if (!status.installed) return status;
    try {
        const backend = createMemoryBackend(localConfig(store), store.rootDir);
        return { ...status, legacyMemories: await backend.countLegacyMemories() };
    } catch {
        return status;
    }
}

function localConfig(store: ClientConfigStore) {
    return createConfig((key) => store.getEnv(key));
}

export async function installLocalModel(store: ClientConfigStore, onProgress: (message: string) => void): Promise<void> {
    await installMlxModel({ homeDir: store.rootDir, onProgress });
}

export async function migrateLegacyMemories(
    store: ClientConfigStore,
    onProgress: (completed: number, total: number) => void,
): Promise<void> {
    if (!getMlxStatus(store.rootDir).installed) throw new Error('Run npx gemdex-mcp install first.');
    const backend = createMemoryBackend(localConfig(store), store.rootDir);
    await backend.migrateLegacy(onProgress);
}

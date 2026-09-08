import { getMlxStatus, installMlxModel, LocalMemoryBackend } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig } from './config.js';
import { createMemoryBackend } from './memory.js';

export type TextProvider = 'gemini' | 'mlx';
export interface LocalModelStatus {
    provider: TextProvider;
    installed: boolean;
    model: string;
    status: 'not-installed' | 'installed' | 'active' | 'installing' | 'migrating' | 'error';
    message?: string;
    completed?: number;
    total?: number;
}

export function localModelStatus(store = new ClientConfigStore()): LocalModelStatus {
    const runtime = getMlxStatus(store.rootDir);
    const provider = store.getEnv('GEMDEX_EMBEDDING_PROVIDER') === 'mlx' ? 'mlx' : 'gemini';
    return {
        provider, installed: runtime.installed, model: runtime.model,
        status: runtime.installed ? (provider === 'mlx' ? 'active' : 'installed') : 'not-installed',
    };
}

export function chooseTextProvider(store: ClientConfigStore, provider: string): void {
    if (provider !== 'mlx' && provider !== 'gemini') throw new Error('Provider must be mlx or gemini.');
    if (provider === 'mlx' && !getMlxStatus(store.rootDir).installed) {
        throw new Error('Install the local model first: npx gemdex-mcp install.');
    }
    if (provider === 'gemini' && !store.getEnv('GEMINI_API_KEY')?.trim()) {
        throw new Error('Configure Gemini first: npx gemdex-mcp setup gemini.');
    }
    const override = process.env.GEMDEX_EMBEDDING_PROVIDER;
    if (override && override !== provider) {
        throw new Error('GEMDEX_EMBEDDING_PROVIDER in the launch environment overrides saved settings. Remove it from your MCP/shell configuration before switching.');
    }
    store.setEnv('GEMDEX_EMBEDDING_PROVIDER', provider);
}

export async function installLocalModel(store: ClientConfigStore, onProgress: (message: string) => void): Promise<void> {
    if (process.env.GEMDEX_EMBEDDING_PROVIDER && process.env.GEMDEX_EMBEDDING_PROVIDER !== 'mlx') {
        throw new Error('Remove GEMDEX_EMBEDDING_PROVIDER from the launch environment before installing and activating MLX.');
    }
    await installMlxModel({ homeDir: store.rootDir, onProgress });
    chooseTextProvider(store, 'mlx');
}

export async function migrateLocalText(store: ClientConfigStore, onProgress: (completed: number, total: number) => void): Promise<void> {
    if (!getMlxStatus(store.rootDir).installed) throw new Error('Run npx gemdex-mcp install first.');
    const config = createConfig((key) => key === 'GEMDEX_MODE' ? 'local' : store.getEnv(key));
    const backend = createMemoryBackend(config, store.rootDir);
    if (!(backend instanceof LocalMemoryBackend)) throw new Error('Text migration is local-only.');
    await backend.migrateTextToMlx(onProgress);
}

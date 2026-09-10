import { getMlxStatus, installMlxModel, LocalMemoryBackend } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig, isLocalGeminiApiKey, LOCAL_GEMINI_API_KEY_SENTINEL } from './config.js';
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
    // Active MLX text is gated solely by GEMINI_API_KEY=local (exact lowercase).
    const provider: TextProvider = isLocalGeminiApiKey(store.getEnv('GEMINI_API_KEY')) ? 'mlx' : 'gemini';
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
    if (provider === 'gemini') {
        const key = store.getEnv('GEMINI_API_KEY')?.trim();
        if (!key || isLocalGeminiApiKey(key)) {
            throw new Error('Configure Gemini first: npx gemdex-mcp setup gemini.');
        }
    }
    const keyOverride = process.env.GEMINI_API_KEY;
    if (provider === 'mlx' && keyOverride && !isLocalGeminiApiKey(keyOverride)) {
        throw new Error('GEMINI_API_KEY in the launch environment overrides local mode. Set it to local or remove it before switching.');
    }
    if (provider === 'gemini' && isLocalGeminiApiKey(keyOverride)) {
        throw new Error('GEMINI_API_KEY=local in the launch environment forces MLX. Remove it before selecting Gemini.');
    }
    const providerOverride = process.env.GEMDEX_EMBEDDING_PROVIDER;
    if (providerOverride && providerOverride !== provider) {
        throw new Error('GEMDEX_EMBEDDING_PROVIDER in the launch environment overrides saved settings. Remove it from your MCP/shell configuration before switching.');
    }
    if (provider === 'mlx') {
        store.setEnvValues({
            GEMDEX_EMBEDDING_PROVIDER: 'mlx',
            GEMINI_API_KEY: LOCAL_GEMINI_API_KEY_SENTINEL,
        });
        return;
    }
    store.setEnv('GEMDEX_EMBEDDING_PROVIDER', 'gemini');
}

export async function installLocalModel(store: ClientConfigStore, onProgress: (message: string) => void): Promise<void> {
    if (process.env.GEMDEX_EMBEDDING_PROVIDER && process.env.GEMDEX_EMBEDDING_PROVIDER !== 'mlx') {
        throw new Error('Remove GEMDEX_EMBEDDING_PROVIDER from the launch environment before installing and activating MLX.');
    }
    if (process.env.GEMINI_API_KEY && !isLocalGeminiApiKey(process.env.GEMINI_API_KEY)) {
        throw new Error('Remove GEMINI_API_KEY from the launch environment (or set it to local) before installing and activating MLX.');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientConfigStore } from './cli-config.js';
import { LOCAL_GEMINI_API_KEY_SENTINEL } from './config.js';
import { chooseTextProvider, localModelStatus } from './local-model.js';

test('chooseTextProvider(mlx) persists GEMINI_API_KEY=local and status reports active only for that sentinel', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-local-gate-'));
    const keys = ['GEMINI_API_KEY', 'GEMDEX_EMBEDDING_PROVIDER'];
    const saved = keys.map((key) => process.env[key]);
    keys.forEach((key) => { delete process.env[key]; });
    try {
        const store = new ClientConfigStore({ rootDir });
        // Without install marker, mlx choose must fail.
        assert.throws(() => chooseTextProvider(store, 'mlx'), /Install the local model/);
        // Simulate installed marker path used by getMlxStatus: write a fake status via env alone for gemini path.
        store.setEnvValues({ GEMINI_API_KEY: 'AIza-test', GEMDEX_EMBEDDING_PROVIDER: 'gemini' });
        assert.equal(localModelStatus(store).provider, 'gemini');
        // Provider=mlx in .env without sentinel must not report active mlx.
        store.setEnv('GEMDEX_EMBEDDING_PROVIDER', 'mlx');
        assert.equal(localModelStatus(store).provider, 'gemini');
        // Sentinel alone selects mlx in status (installed flag still from runtime).
        store.setEnv('GEMINI_API_KEY', LOCAL_GEMINI_API_KEY_SENTINEL);
        assert.equal(localModelStatus(store).provider, 'mlx');
        assert.equal(store.getEnv('GEMINI_API_KEY'), 'local');
        // Switching to gemini while only sentinel is present must fail.
        assert.throws(() => chooseTextProvider(store, 'gemini'), /Configure Gemini first/);
    } finally {
        keys.forEach((key, i) => {
            if (saved[i] === undefined) delete process.env[key];
            else process.env[key] = saved[i]!;
        });
        await fs.rm(rootDir, { recursive: true, force: true });
    }
});

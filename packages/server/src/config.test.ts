import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerConfig } from './config.js';

test('missing token throws unless unsafe dev mode is explicit', () => {
    assert.throws(
        () => loadServerConfig({ env: {}, argv: [] }),
        /GEMDEX_SERVER_TOKEN/,
    );
});

test('unsafe dev mode keeps host and port defaults without a token', () => {
    const cfg = loadServerConfig({ env: { GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true' }, argv: [] });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 8765);
    assert.equal(cfg.token, undefined);
    assert.equal(cfg.unsafeDevNoAuth, true);
    assert.deepEqual(cfg.allowedOrigins, []);
});

test('env vars override defaults', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_HOST: '0.0.0.0',
            GEMDEX_SERVER_PORT: '9000',
            GEMDEX_SERVER_TOKEN: 'secret',
            GEMDEX_SERVER_ALLOWED_ORIGINS: 'https://app.example.test, https://desktop.example.test',
        },
        argv: [],
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.token, 'secret');
    assert.equal(cfg.unsafeDevNoAuth, false);
    assert.deepEqual(cfg.allowedOrigins, ['https://app.example.test', 'https://desktop.example.test']);
    assert.equal(cfg.embeddingModel, 'gemini-embedding-2');
});

test('server-owned Gemini embedding config resolves from env', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_TOKEN: 'secret',
            GEMINI_API_KEY: 'server-key',
            EMBEDDING_MODEL: 'gemini-embedding-001',
            EMBEDDING_DIMENSION: '768',
            GEMINI_BASE_URL: 'https://gemini.example.test',
        },
        argv: [],
    });
    assert.equal(cfg.geminiApiKey, 'server-key');
    assert.equal(cfg.embeddingModel, 'gemini-embedding-001');
    assert.equal(cfg.embeddingDimension, 768);
    assert.equal(cfg.geminiBaseUrl, 'https://gemini.example.test');
});

test('invalid embedding dimension throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({
            env: {
                GEMDEX_SERVER_TOKEN: 'secret',
                EMBEDDING_DIMENSION: 'not-a-dimension',
            },
            argv: [],
        }),
        /EMBEDDING_DIMENSION/,
    );
});

test('embedding dimension rejects non-string and non-number config values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            token: 'secret',
            embeddingDimension: true,
        }), 'utf-8');
        assert.throws(
            () => loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: configPath }, argv: [] }),
            /EMBEDDING_DIMENSION/,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('CLI args --host and --port are parsed', () => {
    const cfg = loadServerConfig({
        env: { GEMDEX_SERVER_TOKEN: 'secret' },
        argv: ['--host', '0.0.0.0', '--port', '3000'],
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 3000);
});

test('invalid port 0 throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_TOKEN: 'secret', GEMDEX_SERVER_PORT: '0' }, argv: [] }),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('0'), `message should mention the bad value: ${err.message}`);
            assert.ok(err.message.includes('1') && err.message.includes('65535'), `message should mention valid range: ${err.message}`);
            return true;
        },
    );
});

test('invalid port 70000 throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_TOKEN: 'secret', GEMDEX_SERVER_PORT: '70000' }, argv: [] }),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('70000'), `message should mention the bad value: ${err.message}`);
            return true;
        },
    );
});

test('invalid port "abc" throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_TOKEN: 'secret', GEMDEX_SERVER_PORT: 'abc' }, argv: [] }),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.toLowerCase().includes('port'), `message should mention port: ${err.message}`);
            return true;
        },
    );
});

test('missing config file throws a clear error naming the path', () => {
    const missingPath = '/tmp/gemdex-server-does-not-exist-12345.json';
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_TOKEN: 'secret', GEMDEX_SERVER_CONFIG: missingPath }, argv: [] }),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes(missingPath), `message should name the path: ${err.message}`);
            return true;
        },
    );
});

test('invalid JSON config file throws a clear error naming the path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'bad.json');
    try {
        fs.writeFileSync(configPath, '{ not valid json }', 'utf-8');
        assert.throws(
            () => loadServerConfig({ env: { GEMDEX_SERVER_TOKEN: 'secret', GEMDEX_SERVER_CONFIG: configPath }, argv: [] }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes(configPath), `message should name the path: ${err.message}`);
                assert.ok(err.message.toLowerCase().includes('json'), `message should mention JSON: ${err.message}`);
                return true;
            },
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('config file values are used when no env override', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            host: '0.0.0.0',
            port: 4567,
            token: 'from-file',
            geminiApiKey: 'file-key',
            embeddingModel: 'gemini-embedding-001',
            embeddingDimension: 1536,
        }), 'utf-8');
        const cfg = loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: configPath }, argv: [] });
        assert.equal(cfg.host, '0.0.0.0');
        assert.equal(cfg.port, 4567);
        assert.equal(cfg.token, 'from-file');
        assert.equal(cfg.geminiApiKey, 'file-key');
        assert.equal(cfg.embeddingModel, 'gemini-embedding-001');
        assert.equal(cfg.embeddingDimension, 1536);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('env vars override config file values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 4567 }), 'utf-8');
        const cfg = loadServerConfig({
            env: {
                GEMDEX_SERVER_CONFIG: configPath,
                GEMDEX_SERVER_TOKEN: 'secret',
                GEMDEX_SERVER_HOST: '192.168.1.1',
                GEMDEX_SERVER_PORT: '9999',
            },
            argv: [],
        });
        assert.equal(cfg.host, '192.168.1.1');
        assert.equal(cfg.port, 9999);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('CLI args parse allowed origins and unsafe dev mode', () => {
    const cfg = loadServerConfig({
        env: {},
        argv: [
            '--unsafe-dev-no-auth',
            '--allowed-origin',
            'https://app.example.test',
            '--allowed-origin=https://desktop.example.test, https://cli.example.test',
        ],
    });
    assert.equal(cfg.unsafeDevNoAuth, true);
    assert.deepEqual(cfg.allowedOrigins, [
        'https://app.example.test',
        'https://desktop.example.test',
        'https://cli.example.test',
    ]);
});

test('--allowed-origin as the final arg with no value does not crash', () => {
    const cfg = loadServerConfig({
        env: { GEMDEX_SERVER_TOKEN: 'secret' },
        argv: ['--allowed-origin'],
    });
    assert.deepEqual(cfg.allowedOrigins, []);
});

test('invalid unsafe dev mode boolean throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'maybe' }, argv: [] }),
        /GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH/,
    );
});

test('database URL resolves from env, CLI, and config file with env precedence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({ databaseUrl: 'postgres://from-file' }), 'utf-8');
        const fromFile = loadServerConfig({
            env: {
                GEMDEX_SERVER_CONFIG: configPath,
                GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            },
            argv: [],
        });
        assert.equal(fromFile.databaseUrl, 'postgres://from-file');

        const fromCli = loadServerConfig({
            env: { GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true' },
            argv: ['--database-url', 'postgres://from-cli'],
        });
        assert.equal(fromCli.databaseUrl, 'postgres://from-cli');

        const fromEnv = loadServerConfig({
            env: {
                GEMDEX_SERVER_CONFIG: configPath,
                DATABASE_URL: 'postgres://platform',
                GEMDEX_SERVER_DATABASE_URL: 'postgres://explicit',
                GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            },
            argv: ['--database-url', 'postgres://from-cli'],
        });
        assert.equal(fromEnv.databaseUrl, 'postgres://explicit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('blob store defaults to file with optional BLOB_DIR', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            BLOB_STORE: 'file',
            BLOB_DIR: '/var/lib/gemdex/blobs',
        },
        argv: [],
    });
    assert.deepEqual(cfg.blobStore, { kind: 'file', directory: '/var/lib/gemdex/blobs' });
});

test('BLOB_STORE=s3 resolves S3-compatible env vars', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            BLOB_STORE: 's3',
            S3_BUCKET: 'gemdex-blobs',
            S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
            S3_REGION: 'auto',
            S3_PREFIX: 'tenant-a/blobs',
            S3_ACCESS_KEY_ID: 'key',
            S3_SECRET_ACCESS_KEY: 'secret',
            S3_FORCE_PATH_STYLE: 'true',
        },
        argv: [],
    });
    assert.deepEqual(cfg.blobStore, {
        kind: 's3',
        bucket: 'gemdex-blobs',
        endpoint: 'https://example.r2.cloudflarestorage.com',
        region: 'auto',
        prefix: 'tenant-a/blobs',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
    });
});

test('BLOB_STORE=s3 requires a bucket', () => {
    assert.throws(
        () => loadServerConfig({
            env: { GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true', BLOB_STORE: 's3' },
            argv: [],
        }),
        /S3_BUCKET/,
    );
});

test('empty S3 credential env vars fall back to AWS_* equivalents', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            BLOB_STORE: 's3',
            S3_BUCKET: 'gemdex-blobs',
            S3_ACCESS_KEY_ID: '',
            S3_SECRET_ACCESS_KEY: '',
            AWS_ACCESS_KEY_ID: 'aws-key',
            AWS_SECRET_ACCESS_KEY: 'aws-secret',
        },
        argv: [],
    });
    assert.equal(cfg.blobStore.kind, 's3');
    if (cfg.blobStore.kind === 's3') {
        assert.equal(cfg.blobStore.accessKeyId, 'aws-key');
        assert.equal(cfg.blobStore.secretAccessKey, 'aws-secret');
    }
});

test('config file can provide blobStore settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-server-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            blobStore: {
                kind: 's3',
                bucket: 'from-file',
                endpoint: 'http://localhost:9000',
                forcePathStyle: true,
            },
        }), 'utf-8');
        const cfg = loadServerConfig({
            env: {
                GEMDEX_SERVER_CONFIG: configPath,
                GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH: 'true',
            },
            argv: [],
        });
        assert.deepEqual(cfg.blobStore, {
            kind: 's3',
            bucket: 'from-file',
            endpoint: 'http://localhost:9000',
            region: 'auto',
            forcePathStyle: true,
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerConfig } from './config.js';

test('defaults: host 127.0.0.1, port 8765', () => {
    const cfg = loadServerConfig({ env: {}, argv: [] });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 8765);
    assert.equal(cfg.token, undefined);
});

test('env vars override defaults', () => {
    const cfg = loadServerConfig({
        env: {
            GEMDEX_SERVER_HOST: '0.0.0.0',
            GEMDEX_SERVER_PORT: '9000',
            GEMDEX_SERVER_TOKEN: 'secret',
        },
        argv: [],
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.token, 'secret');
});

test('CLI args --host and --port are parsed', () => {
    const cfg = loadServerConfig({
        env: {},
        argv: ['--host', '0.0.0.0', '--port', '3000'],
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 3000);
});

test('invalid port 0 throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_PORT: '0' }, argv: [] }),
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
        () => loadServerConfig({ env: { GEMDEX_SERVER_PORT: '70000' }, argv: [] }),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('70000'), `message should mention the bad value: ${err.message}`);
            return true;
        },
    );
});

test('invalid port "abc" throws a clear error', () => {
    assert.throws(
        () => loadServerConfig({ env: { GEMDEX_SERVER_PORT: 'abc' }, argv: [] }),
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
        () => loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: missingPath }, argv: [] }),
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
            () => loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: configPath }, argv: [] }),
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
        fs.writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 4567, token: 'from-file' }), 'utf-8');
        const cfg = loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: configPath }, argv: [] });
        assert.equal(cfg.host, '0.0.0.0');
        assert.equal(cfg.port, 4567);
        assert.equal(cfg.token, 'from-file');
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

test('blob store defaults to file with optional BLOB_DIR', () => {
    const cfg = loadServerConfig({
        env: { BLOB_STORE: 'file', BLOB_DIR: '/var/lib/gemdex/blobs' },
        argv: [],
    });
    assert.deepEqual(cfg.blobStore, { kind: 'file', directory: '/var/lib/gemdex/blobs' });
});

test('BLOB_STORE=s3 resolves S3-compatible env vars', () => {
    const cfg = loadServerConfig({
        env: {
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
        () => loadServerConfig({ env: { BLOB_STORE: 's3' }, argv: [] }),
        /S3_BUCKET/,
    );
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
        const cfg = loadServerConfig({ env: { GEMDEX_SERVER_CONFIG: configPath }, argv: [] });
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

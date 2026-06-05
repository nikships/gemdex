import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileBlobStore, S3BlobStore } from 'gemdex-core';
import { createBlobStore } from './blob-store.js';

test('createBlobStore builds file blob stores', () => {
    const store = createBlobStore({ kind: 'file', directory: '/tmp/gemdex-blobs' });
    assert.ok(store instanceof FileBlobStore);
    assert.equal((store as FileBlobStore).getRoot(), '/tmp/gemdex-blobs');
});

test('createBlobStore builds S3-compatible blob stores', () => {
    const store = createBlobStore({
        kind: 's3',
        bucket: 'gemdex-blobs',
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
    });
    assert.ok(store instanceof S3BlobStore);
});

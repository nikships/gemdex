import { FileBlobStore, S3BlobStore } from 'gemdex-core';
import type { BlobStore } from 'gemdex-core';
import type { BlobStoreConfig } from './config.js';

export function createBlobStore(config: BlobStoreConfig): BlobStore {
    if (config.kind === 'file') {
        return new FileBlobStore(config.directory);
    }
    return new S3BlobStore({
        bucket: config.bucket,
        ...(config.prefix && { prefix: config.prefix }),
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.region && { region: config.region }),
        ...(config.accessKeyId && { accessKeyId: config.accessKeyId }),
        ...(config.secretAccessKey && { secretAccessKey: config.secretAccessKey }),
        ...(config.forcePathStyle !== undefined && { forcePathStyle: config.forcePathStyle }),
    });
}

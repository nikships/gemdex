import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';

/**
 * Raw-byte storage for memory attachments. Media bytes are kept out of the
 * LanceDB row (base64 in the vector table bloats it badly for
 * audio/video/PDF). Each attachment is addressed by an opaque `blobRef` that
 * the memory metadata stores alongside its mimeType/byteLength.
 */
export interface BlobStore {
    /** Persist bytes for an attachment and return a stable, relocatable ref. */
    put(parentId: string, attachmentId: string, data: Buffer): Promise<string>;
    /** Read the bytes for a ref. Throws if the blob is missing. */
    get(blobRef: string): Promise<Buffer>;
    /** Whether a ref currently resolves to a blob. */
    has(blobRef: string): Promise<boolean>;
    /** Remove every blob belonging to a parent memory. No-op if absent. */
    deleteParent(parentId: string): Promise<void>;
}

// Internal ids (UUIDs, numeric indices) are already filesystem-safe; this is a
// defensive guard so a hand-crafted ref can never escape the store root.
function safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Filesystem-backed BlobStore. Layout: `<root>/<parentId>/<attachmentId>`,
 * with `<root>` defaulting to `~/.gemdex/blobs` (a sibling of the LanceDB
 * store). The root directory is created lazily on first write so constructing
 * a MemoryStore that never stores media touches nothing on disk.
 */
export class FileBlobStore implements BlobStore {
    private readonly root: string;
    private ensured = false;

    constructor(root?: string) {
        this.root = root ?? path.join(os.homedir(), '.gemdex', 'blobs');
    }

    /** Absolute path of the store root (useful for diagnostics/tests). */
    getRoot(): string {
        return this.root;
    }

    private async ensureRoot(): Promise<void> {
        if (this.ensured) return;
        await fs.mkdir(this.root, { recursive: true });
        this.ensured = true;
    }

    private resolveRef(blobRef: string): string {
        const resolved = path.resolve(this.root, blobRef);
        const rootResolved = path.resolve(this.root);
        if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
            throw new Error(`Refusing to access blob outside store root: ${blobRef}`);
        }
        return resolved;
    }

    async put(parentId: string, attachmentId: string, data: Buffer): Promise<string> {
        await this.ensureRoot();
        const blobRef = path.posix.join(safeSegment(parentId), safeSegment(attachmentId));
        const absPath = this.resolveRef(blobRef);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, data);
        return blobRef;
    }

    async get(blobRef: string): Promise<Buffer> {
        return fs.readFile(this.resolveRef(blobRef));
    }

    async has(blobRef: string): Promise<boolean> {
        try {
            await fs.access(this.resolveRef(blobRef));
            return true;
        } catch {
            return false;
        }
    }

    async deleteParent(parentId: string): Promise<void> {
        const segment = safeSegment(parentId);
        // `safeSegment` permits '.' and '..' (only allowed chars), so guard
        // explicitly: a '.'/'..' parentId would otherwise resolve to the store
        // root or its parent and recursively delete unrelated data.
        const dir = path.resolve(this.root, segment);
        const rootResolved = path.resolve(this.root);
        if (segment === '.' || segment === '..' || dir === rootResolved || !dir.startsWith(rootResolved + path.sep)) {
            throw new Error(`Refusing to delete blobs outside store root: ${parentId}`);
        }
        await fs.rm(dir, { recursive: true, force: true });
    }
}

export interface S3BlobStoreOptions {
    bucket: string;
    /** Prefix under the bucket, e.g. `gemdex/blobs`. Leading/trailing slashes are ignored. */
    prefix?: string;
    /** S3-compatible endpoint for R2, MinIO, etc. Omit for AWS S3. */
    endpoint?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    client?: Pick<S3Client, 'send'>;
}

type S3Body = {
    transformToByteArray?: () => Promise<Uint8Array>;
    transformToString?: () => Promise<string>;
} | AsyncIterable<Uint8Array> | Uint8Array | Buffer | string;

/**
 * S3-compatible BlobStore for AWS S3, Cloudflare R2, MinIO, and similar
 * services. Layout mirrors FileBlobStore at `<prefix>/<parentId>/<attachmentId>`
 * so refs remain opaque but portable across drivers.
 */
export class S3BlobStore implements BlobStore {
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly client: Pick<S3Client, 'send'>;

    constructor(options: S3BlobStoreOptions) {
        if (!options.bucket.trim()) {
            throw new Error('S3 blob store requires a bucket');
        }
        this.bucket = options.bucket;
        this.prefix = S3BlobStore.normalizePrefix(options.prefix);
        this.client = options.client ?? new S3Client({
            ...(options.region && { region: options.region }),
            ...(options.endpoint && { endpoint: options.endpoint }),
            ...(options.forcePathStyle !== undefined && { forcePathStyle: options.forcePathStyle }),
            ...(options.accessKeyId && options.secretAccessKey && {
                credentials: {
                    accessKeyId: options.accessKeyId,
                    secretAccessKey: options.secretAccessKey,
                },
            }),
        });
    }

    private static normalizePrefix(prefix: string | undefined): string {
        return (prefix ?? '').replace(/^\/+|\/+$/g, '');
    }

    private toKey(blobRef: string): string {
        const normalized = blobRef.split('/').filter((segment) => segment && segment !== '.' && segment !== '..').join('/');
        if (!normalized) {
            throw new Error(`Invalid empty blob ref: ${blobRef}`);
        }
        return this.prefix ? `${this.prefix}/${normalized}` : normalized;
    }

    private parentPrefix(parentId: string): string {
        const segment = safeSegment(parentId);
        if (segment === '.' || segment === '..') {
            throw new Error(`Refusing to delete unsafe blob prefix: ${parentId}`);
        }
        return this.toKey(`${segment}/`);
    }

    async put(parentId: string, attachmentId: string, data: Buffer): Promise<string> {
        const blobRef = path.posix.join(safeSegment(parentId), safeSegment(attachmentId));
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.toKey(blobRef),
            Body: data,
        }));
        return blobRef;
    }

    async get(blobRef: string): Promise<Buffer> {
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.toKey(blobRef),
        }));
        return S3BlobStore.bodyToBuffer(response.Body as S3Body | undefined);
    }

    async has(blobRef: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: this.toKey(blobRef),
            }));
            return true;
        } catch (error) {
            if (S3BlobStore.isNotFound(error)) return false;
            throw error;
        }
    }

    async deleteParent(parentId: string): Promise<void> {
        const prefix = this.parentPrefix(parentId);
        let continuationToken: string | undefined;
        do {
            const listed = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }));
            const objects = listed.Contents ?? [];
            const keys = objects
                .map((object) => object.Key)
                .filter((key): key is string => typeof key === 'string' && key.length > 0);
            // Bulk-delete each page in a single request (S3 DeleteObjects
            // accepts up to 1000 keys, and ListObjectsV2 returns at most 1000
            // per page) rather than firing one DeleteObject per key, which
            // risks rate-limiting and socket exhaustion on large parents.
            if (keys.length > 0) {
                await this.client.send(new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: { Objects: keys.map((key) => ({ Key: key })) },
                }));
            }
            continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    private static async bodyToBuffer(body: S3Body | undefined): Promise<Buffer> {
        if (!body) return Buffer.alloc(0);
        if (Buffer.isBuffer(body)) return body;
        if (typeof body === 'string') return Buffer.from(body);
        if (body instanceof Uint8Array) return Buffer.from(body);
        if ('transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
            return Buffer.from(await body.transformToByteArray());
        }
        if ('transformToString' in body && typeof body.transformToString === 'function') {
            return Buffer.from(await body.transformToString());
        }
        if (typeof body === 'object' && Symbol.asyncIterator in body) {
            const chunks: Buffer[] = [];
            for await (const chunk of body) {
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        }
        throw new Error('Unsupported S3 response body');
    }

    private static isNotFound(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
    }
}

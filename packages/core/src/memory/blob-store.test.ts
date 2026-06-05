import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileBlobStore } from './blob-store';

describe('FileBlobStore', () => {
    let root: string;
    let store: FileBlobStore;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-blob-test-'));
        store = new FileBlobStore(root);
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('round-trips bytes through put/get', async () => {
        const data = Buffer.from('hello-blob-bytes');
        const ref = await store.put('parent-1', '0', data);
        expect(ref).toContain('parent-1');
        expect(await store.has(ref)).toBe(true);
        const got = await store.get(ref);
        expect(got.equals(data)).toBe(true);
    });

    it('deleteParent removes every blob for a parent', async () => {
        const ref0 = await store.put('p', '0', Buffer.from('a'));
        const ref1 = await store.put('p', '1', Buffer.from('b'));
        await store.deleteParent('p');
        expect(await store.has(ref0)).toBe(false);
        expect(await store.has(ref1)).toBe(false);
    });

    it('does not create the root directory until the first write', async () => {
        const lazyRoot = path.join(root, 'nested', 'blobs');
        const lazy = new FileBlobStore(lazyRoot);
        await expect(fs.access(lazyRoot)).rejects.toBeDefined();
        await lazy.put('p', '0', Buffer.from('x'));
        await expect(fs.access(lazyRoot)).resolves.toBeUndefined();
    });

    it('refuses to read outside the store root', async () => {
        await expect(store.get('../../etc/passwd')).rejects.toThrow(/outside store root/i);
    });

    it('refuses to deleteParent with a "." or ".." traversal segment', async () => {
        const ref = await store.put('keep', '0', Buffer.from('safe-bytes'));
        await expect(store.deleteParent('..')).rejects.toThrow(/outside store root/i);
        await expect(store.deleteParent('.')).rejects.toThrow(/outside store root/i);
        // The store root and its existing blobs are untouched.
        expect(await store.has(ref)).toBe(true);
    });
});

describe('S3BlobStore', () => {
    class FakeS3Client {
        readonly objects = new Map<string, Buffer>();

        async send(command: { constructor: { name: string }; input?: Record<string, any> }): Promise<Record<string, any>> {
            const input = command.input ?? {};
            const key = input.Key as string | undefined;
            if (command.constructor.name === 'PutObjectCommand') {
                this.objects.set(key!, Buffer.from(input.Body as Buffer));
                return {};
            }
            if (command.constructor.name === 'GetObjectCommand') {
                const object = this.objects.get(key!);
                if (!object) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
                return { Body: object };
            }
            if (command.constructor.name === 'HeadObjectCommand') {
                if (!this.objects.has(key!)) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
                return {};
            }
            if (command.constructor.name === 'ListObjectsV2Command') {
                const prefix = input.Prefix as string;
                const keys = Array.from(this.objects.keys()).filter((candidate) => candidate.startsWith(prefix));
                return { Contents: keys.map((candidate) => ({ Key: candidate })), IsTruncated: false };
            }
            if (command.constructor.name === 'DeleteObjectCommand') {
                this.objects.delete(key!);
                return {};
            }
            throw new Error(`Unhandled command ${command.constructor.name}`);
        }
    }

    it('round-trips bytes through an S3-compatible client', async () => {
        const { S3BlobStore } = await import('./blob-store');
        const client = new FakeS3Client();
        const store = new S3BlobStore({ bucket: 'gemdex-test', prefix: 'blobs', client });
        const data = Buffer.from('hello-s3-bytes');

        const ref = await store.put('parent-1', '0', data);

        expect(ref).toBe('parent-1/0');
        expect(client.objects.get('blobs/parent-1/0')?.equals(data)).toBe(true);
        expect(await store.has(ref)).toBe(true);
        expect((await store.get(ref)).equals(data)).toBe(true);
    });

    it('deleteParent deletes only objects under the parent prefix', async () => {
        const { S3BlobStore } = await import('./blob-store');
        const client = new FakeS3Client();
        const store = new S3BlobStore({ bucket: 'gemdex-test', prefix: '/blobs/', client });
        const ref0 = await store.put('p', '0', Buffer.from('a'));
        const ref1 = await store.put('p', '1', Buffer.from('b'));
        const keepRef = await store.put('other', '0', Buffer.from('c'));

        await store.deleteParent('p');

        expect(await store.has(ref0)).toBe(false);
        expect(await store.has(ref1)).toBe(false);
        expect(await store.has(keepRef)).toBe(true);
    });

    it('reports missing S3 objects without throwing from has', async () => {
        const { S3BlobStore } = await import('./blob-store');
        const store = new S3BlobStore({ bucket: 'gemdex-test', client: new FakeS3Client() });

        await expect(store.has('missing/0')).resolves.toBe(false);
    });
});

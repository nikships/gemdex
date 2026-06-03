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
});

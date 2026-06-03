import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Raw-byte storage for memory attachments. Media bytes are kept on disk rather
 * than inline in the LanceDB row (base64 in the vector table bloats it badly
 * for audio/video/PDF). Each attachment is addressed by an opaque `blobRef`
 * that the memory metadata stores alongside its mimeType/byteLength.
 */
export interface BlobStore {
    /** Persist bytes for an attachment and return a stable, relocatable ref. */
    put(parentId: string, attachmentId: string, data: Buffer): Promise<string>;
    /** Read the bytes for a ref. Throws if the blob is missing. */
    get(blobRef: string): Promise<Buffer>;
    /** Whether a ref currently resolves to a file. */
    has(blobRef: string): Promise<boolean>;
    /** Remove every blob belonging to a parent memory. No-op if absent. */
    deleteParent(parentId: string): Promise<void>;
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

    // Internal ids (UUIDs, numeric indices) are already filesystem-safe; this
    // is a defensive guard so a hand-crafted ref can never escape the root.
    private static safeSegment(value: string): string {
        return value.replace(/[^A-Za-z0-9._-]/g, '_');
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
        const dirSegment = FileBlobStore.safeSegment(parentId);
        const fileSegment = FileBlobStore.safeSegment(attachmentId);
        const blobRef = path.posix.join(dirSegment, fileSegment);
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
        const segment = FileBlobStore.safeSegment(parentId);
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

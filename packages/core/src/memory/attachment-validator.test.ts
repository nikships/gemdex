import {
    validateAttachments,
    AttachmentValidationError,
    SUPPORTED_MIME_TYPES,
    SUPPORTED_ATTACHMENT_EXTENSIONS,
    mimeToKind,
    inferMimeTypeFromPath,
    DEFAULT_ATTACHMENT_LIMITS,
} from './attachment-validator';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('validateAttachments', () => {
    it('accepts a supported image, decodes bytes, and trims the caption', () => {
        const [a] = validateAttachments([{ mimeType: 'image/png', data: b64('pngbytes'), caption: '  login screen  ' }]);
        expect(a.kind).toBe('image');
        expect(a.byteLength).toBe(Buffer.from('pngbytes').length);
        expect(a.caption).toBe('login screen');
    });

    it('rejects an unsupported mimeType', () => {
        expect(() => validateAttachments([{ mimeType: 'image/gif', data: b64('x') }]))
            .toThrow(AttachmentValidationError);
    });

    it('rejects empty bytes', () => {
        expect(() => validateAttachments([{ mimeType: 'image/png', data: '' }]))
            .toThrow(/0 bytes/);
    });

    it('enforces the image count cap', () => {
        const many = Array.from({ length: 7 }, () => ({ mimeType: 'image/png', data: b64('x') }));
        expect(() => validateAttachments(many)).toThrow(/Too many image/);
    });

    it('enforces the PDF count cap', () => {
        const pdfs = [
            { mimeType: 'application/pdf', data: b64('p1') },
            { mimeType: 'application/pdf', data: b64('p2') },
        ];
        expect(() => validateAttachments(pdfs)).toThrow(/Too many PDF/);
    });

    it('enforces the per-attachment byte ceiling', () => {
        const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerAttachment: 4 };
        expect(() => validateAttachments([{ mimeType: 'image/png', data: b64('12345') }], limits))
            .toThrow(/per-attachment limit/);
    });

    it('tolerates a data: URL prefix', () => {
        const [a] = validateAttachments([{ mimeType: 'image/png', data: `data:image/png;base64,${b64('z')}` }]);
        expect(a.byteLength).toBe(1);
    });

    it('maps mimeTypes to kinds and exposes a non-empty supported list', () => {
        expect(mimeToKind('application/pdf')).toBe('pdf');
        expect(mimeToKind('audio/wav')).toBe('audio');
        expect(mimeToKind('video/mp4')).toBe('video');
        expect(mimeToKind('text/plain')).toBeUndefined();
        expect(SUPPORTED_MIME_TYPES.length).toBeGreaterThan(0);
    });
});

describe('inferMimeTypeFromPath', () => {
    it('maps each supported extension to a supported mimeType', () => {
        expect(inferMimeTypeFromPath('/a/b/photo.png')).toBe('image/png');
        expect(inferMimeTypeFromPath('clip.mp4')).toBe('video/mp4');
        expect(inferMimeTypeFromPath('rec.mov')).toBe('video/quicktime');
        expect(inferMimeTypeFromPath('doc.pdf')).toBe('application/pdf');
        for (const ext of SUPPORTED_ATTACHMENT_EXTENSIONS) {
            const mime = inferMimeTypeFromPath(`file${ext}`);
            expect(mime).toBeDefined();
            expect(SUPPORTED_MIME_TYPES).toContain(mime);
        }
    });

    it('is case-insensitive on the extension', () => {
        expect(inferMimeTypeFromPath('/x/Photo.JPG')).toBe('image/jpeg');
        expect(inferMimeTypeFromPath('CLIP.MP4')).toBe('video/mp4');
    });

    it('returns undefined for unknown or missing extensions', () => {
        expect(inferMimeTypeFromPath('notes.txt')).toBeUndefined();
        expect(inferMimeTypeFromPath('archive.gif')).toBeUndefined();
        expect(inferMimeTypeFromPath('README')).toBeUndefined();
    });
});

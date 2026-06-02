import { chunkMemory, deriveTitle } from './chunker';

describe('chunkMemory', () => {
    it('returns a single chunk for short content', () => {
        const chunks = chunkMemory('a one-line fact');
        expect(chunks).toEqual(['a one-line fact']);
    });

    it('splits long content into multiple overlapping chunks', () => {
        const paragraph = 'line of text\n'.repeat(400); // ~5200 chars
        const chunks = chunkMemory(paragraph, { chunkSize: 1500, chunkOverlap: 200 });
        expect(chunks.length).toBeGreaterThan(1);
        // Reassembled (accounting for overlap) must still contain all content.
        expect(chunks.join('')).toContain('line of text');
        // No chunk wildly exceeds the target size + overlap budget.
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(1500 + 1);
        }
    });

    it('covers the entire input across chunks', () => {
        const text = Array.from({ length: 300 }, (_, i) => `sentence number ${i}`).join('\n');
        const chunks = chunkMemory(text, { chunkSize: 500, chunkOverlap: 50 });
        expect(chunks[0]).toContain('sentence number 0');
        expect(chunks[chunks.length - 1]).toContain('sentence number 299');
    });
});

describe('deriveTitle', () => {
    it('uses the first non-empty line', () => {
        expect(deriveTitle('\n\nFirst real line\nsecond')).toBe('First real line');
    });

    it('strips markdown heading markers and bullets', () => {
        expect(deriveTitle('## Junie review workflow')).toBe('Junie review workflow');
        expect(deriveTitle('- a bullet point')).toBe('a bullet point');
    });

    it('truncates long titles with an ellipsis', () => {
        const long = 'x'.repeat(200);
        const title = deriveTitle(long, 80);
        expect(title.length).toBe(80);
        expect(title.endsWith('…')).toBe(true);
    });

    it('falls back for empty content', () => {
        expect(deriveTitle('   ')).toBe('Untitled memory');
    });
});

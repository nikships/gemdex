import { applyContentEdits } from './content-edits';

describe('applyContentEdits', () => {
    it('replaces a single occurrence', () => {
        const result = applyContentEdits('the quick brown fox', [
            { oldText: 'quick', newText: 'slow' },
        ]);
        expect(result).toBe('the slow brown fox');
    });

    it('applies edits sequentially, each against the previous result', () => {
        const result = applyContentEdits('a b c', [
            { oldText: 'a', newText: 'x' },
            { oldText: 'x b', newText: 'y' },
        ]);
        expect(result).toBe('y c');
    });

    it('replaces every occurrence when replaceAll is set', () => {
        const result = applyContentEdits('foo foo foo', [
            { oldText: 'foo', newText: 'bar', replaceAll: true },
        ]);
        expect(result).toBe('bar bar bar');
    });

    it('treats matches as non-overlapping (replaceAll on "aa" within "aaa")', () => {
        const result = applyContentEdits('aaa', [
            { oldText: 'aa', newText: 'b', replaceAll: true },
        ]);
        // First match consumes index 0-1; remaining "a" has no further match.
        expect(result).toBe('ba');
    });

    it('throws when oldText is not found', () => {
        expect(() => applyContentEdits('hello world', [{ oldText: 'absent', newText: 'x' }]))
            .toThrow(/not found in memory content/);
    });

    it('throws when oldText is not unique and replaceAll is not set', () => {
        expect(() => applyContentEdits('foo foo', [{ oldText: 'foo', newText: 'bar' }]))
            .toThrow(/not unique \(2 matches\)/);
    });

    it('throws on an empty edit list', () => {
        expect(() => applyContentEdits('content', []))
            .toThrow(/at least one edit is required/);
    });

    it('throws on an empty oldText (does not hang)', () => {
        expect(() => applyContentEdits('content', [{ oldText: '', newText: 'x' }]))
            .toThrow(/'oldText' must not be empty/);
    });

    it('throws when oldText and newText are identical', () => {
        expect(() => applyContentEdits('content', [{ oldText: 'same', newText: 'same' }]))
            .toThrow(/identical/);
    });
});

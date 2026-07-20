import { DEFAULT_DIGEST_MODEL } from '../ingest/digester';
import {
    ClusterJudge,
    JUDGE_CONTENT_CHAR_LIMIT,
    JudgeMemberInput,
    buildJudgePrompt,
    parseJudgeResponse,
} from './judge';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: jest.fn() },
    })),
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' },
}));

function member(id: string, updatedAt: number, content = `content of ${id}`): JudgeMemberInput {
    return {
        memoryId: id,
        title: `title ${id}`,
        createdAt: updatedAt - 100,
        updatedAt,
        content,
    };
}

describe('parseJudgeResponse', () => {
    // memberIds are ordered newest-first (scan order).
    const memberIds = ['new', 'mid', 'old'];

    it('parses a full structured response and maps snake_case to camelCase', () => {
        const findings = parseJudgeResponse(JSON.stringify([
            { memory_id: 'new', verdict: 'keep', confidence: 'high' },
            { memory_id: 'mid', verdict: 'superseded', superseded_by: 'new', evidence: '"port 8080" vs "port 9090"', confidence: 'medium' },
            { memory_id: 'old', verdict: 'duplicate', superseded_by: 'new', confidence: 'high' },
        ]), memberIds);
        expect(findings).toEqual([
            { memoryId: 'new', verdict: 'keep', confidence: 'high' },
            { memoryId: 'mid', verdict: 'superseded', supersededBy: 'new', evidence: '"port 8080" vs "port 9090"', confidence: 'medium' },
            { memoryId: 'old', verdict: 'duplicate', supersededBy: 'new', confidence: 'high' },
        ]);
    });

    it('defaults an unmentioned member to keep/low', () => {
        const findings = parseJudgeResponse(JSON.stringify([
            { memory_id: 'new', verdict: 'keep', confidence: 'high' },
            { memory_id: 'old', verdict: 'duplicate', confidence: 'high' },
        ]), memberIds);
        expect(findings.find((f) => f.memoryId === 'mid')).toEqual({
            memoryId: 'mid', verdict: 'keep', confidence: 'low',
        });
        expect(findings).toHaveLength(3);
    });

    it('ignores hallucinated ids', () => {
        const findings = parseJudgeResponse(JSON.stringify([
            { memory_id: 'new', verdict: 'keep', confidence: 'high' },
            { memory_id: 'ghost', verdict: 'duplicate', confidence: 'high' },
        ]), memberIds);
        expect(findings.map((f) => f.memoryId)).toEqual(memberIds);
    });

    it('flips the newest member to keep when everything is condemned', () => {
        const findings = parseJudgeResponse(JSON.stringify([
            { memory_id: 'new', verdict: 'duplicate', confidence: 'high' },
            { memory_id: 'mid', verdict: 'superseded', confidence: 'high' },
            { memory_id: 'old', verdict: 'contradicted', confidence: 'high' },
        ]), memberIds);
        expect(findings[0]).toEqual({ memoryId: 'new', verdict: 'keep', confidence: 'low' });
        expect(findings[1].verdict).toBe('superseded');
        expect(findings[2].verdict).toBe('contradicted');
    });

    it('throws on malformed JSON and non-array responses', () => {
        expect(() => parseJudgeResponse('not json', memberIds)).toThrow(/invalid JSON/);
        expect(() => parseJudgeResponse('{"a":1}', memberIds)).toThrow(/non-array/);
    });
});

describe('buildJudgePrompt', () => {
    it('orders memories oldest-first with title, ISO timestamps, and content', () => {
        const prompt = buildJudgePrompt([
            member('newest', Date.parse('2026-06-01T00:00:00.000Z')),
            member('oldest', Date.parse('2026-01-01T00:00:00.000Z')),
        ]);
        expect(prompt.indexOf('=== MEMORY oldest ===')).toBeLessThan(prompt.indexOf('=== MEMORY newest ==='));
        expect(prompt).toContain('title: title oldest');
        expect(prompt).toContain('updatedAt: 2026-01-01T00:00:00.000Z');
        expect(prompt).toContain('content:\ncontent of oldest');
    });

    it('truncates long content to the char limit', () => {
        const long = 'x'.repeat(JUDGE_CONTENT_CHAR_LIMIT + 500);
        const prompt = buildJudgePrompt([member('big', 1_000, long)]);
        expect(prompt).toContain('[truncated]');
        expect(prompt).not.toContain('x'.repeat(JUDGE_CONTENT_CHAR_LIMIT + 1));
    });
});

describe('ClusterJudge', () => {
    it('defaults to the digest default model and rejects unknown models', () => {
        expect(new ClusterJudge({ apiKey: 'k' }).model).toBe(DEFAULT_DIGEST_MODEL);
        expect(() => new ClusterJudge({ apiKey: 'k', model: 'gemini-1.5-pro' }))
            .toThrow(/Unsupported judge model/);
    });

    it('judges via generateContent and parses the JSON text', async () => {
        const judge = new ClusterJudge({ apiKey: 'k' });
        const generateContent = (judge.getClient().models.generateContent as jest.Mock);
        generateContent.mockResolvedValue({
            text: JSON.stringify([
                { memory_id: 'a', verdict: 'keep', confidence: 'high' },
                { memory_id: 'b', verdict: 'duplicate', superseded_by: 'a', confidence: 'high' },
            ]),
        });
        const findings = await judge.judge([member('a', 2_000), member('b', 1_000)]);
        expect(findings).toHaveLength(2);
        expect(findings[1].verdict).toBe('duplicate');
        expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: DEFAULT_DIGEST_MODEL,
            config: expect.objectContaining({ responseMimeType: 'application/json', temperature: 0 }),
        }));
    });

    it('throws when the model returns no text', async () => {
        const judge = new ClusterJudge({ apiKey: 'k' });
        (judge.getClient().models.generateContent as jest.Mock).mockResolvedValue({ text: undefined });
        await expect(judge.judge([member('a', 1)])).rejects.toThrow(/empty response/);
    });
});

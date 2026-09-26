import { ClaudeCodeRunner, ClaudeStructuredRequest, DEFAULT_CLAUDE_MODEL } from '../inference/claude-code';
import {
    ClusterJudge,
    JUDGE_CONTENT_CHAR_LIMIT,
    JUDGE_RESPONSE_SCHEMA,
    JudgeMemberInput,
    buildJudgePrompt,
    parseJudgeOutput,
    parseJudgeResponse,
} from './judge';

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

    it('accepts the { verdicts } wrapper as JSON text', () => {
        const findings = parseJudgeResponse(JSON.stringify({ verdicts: [
            { memory_id: 'old', verdict: 'duplicate', superseded_by: 'new', confidence: 'high' },
        ] }), memberIds);
        expect(findings.find((f) => f.memoryId === 'old')?.verdict).toBe('duplicate');
        expect(findings).toHaveLength(3);
    });

    it('throws on malformed JSON and responses with no verdict list', () => {
        expect(() => parseJudgeResponse('not json', memberIds)).toThrow(/invalid JSON/);
        expect(() => parseJudgeResponse('{"a":1}', memberIds)).toThrow(/no verdict list/);
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

describe('parseJudgeOutput', () => {
    const memberIds = ['new', 'old'];

    it('accepts the { verdicts } object and a bare array identically', () => {
        const verdicts = [
            { memory_id: 'new', verdict: 'keep', confidence: 'high' },
            { memory_id: 'old', verdict: 'superseded', superseded_by: 'new', evidence: 'e', confidence: 'medium' },
        ];
        const expected = [
            { memoryId: 'new', verdict: 'keep', confidence: 'high' },
            { memoryId: 'old', verdict: 'superseded', supersededBy: 'new', evidence: 'e', confidence: 'medium' },
        ];
        expect(parseJudgeOutput({ verdicts }, memberIds)).toEqual(expected);
        expect(parseJudgeOutput(verdicts, memberIds)).toEqual(expected);
    });

    it('coerces unknown verdict/confidence values to keep/low', () => {
        expect(parseJudgeOutput({ verdicts: [
            { memory_id: 'new', verdict: 'nuke', confidence: 'certain' },
        ] }, memberIds)[0]).toEqual({ memoryId: 'new', verdict: 'keep', confidence: 'low' });
    });

    it('throws when there is no verdict list', () => {
        expect(() => parseJudgeOutput({ verdicts: 'nope' }, memberIds)).toThrow(/no verdict list/);
        expect(() => parseJudgeOutput(null, memberIds)).toThrow(/no verdict list/);
        expect(() => parseJudgeOutput('text', memberIds)).toThrow(/no verdict list/);
    });
});

describe('JUDGE_RESPONSE_SCHEMA', () => {
    it('is a JSON Schema object with verdicts at the top level', () => {
        expect(JUDGE_RESPONSE_SCHEMA.type).toBe('object');
        expect(JUDGE_RESPONSE_SCHEMA.required).toEqual(['verdicts']);
        expect(JUDGE_RESPONSE_SCHEMA.properties.verdicts.type).toBe('array');
        expect(JUDGE_RESPONSE_SCHEMA.properties.verdicts.items.required)
            .toEqual(['memory_id', 'verdict', 'confidence']);
    });
});

function fakeRunner(output: unknown): { runner: ClaudeCodeRunner; runStructured: jest.Mock } {
    const runStructured = jest.fn(async (_request: ClaudeStructuredRequest) => ({ output, models: ['claude-haiku-4-5'] }));
    return { runner: { runStructured } as unknown as ClaudeCodeRunner, runStructured };
}

describe('ClusterJudge', () => {
    it('defaults to the Claude Code default model and rejects unknown models', () => {
        const { runner } = fakeRunner({ verdicts: [] });
        expect(new ClusterJudge({ runner }).model).toBe(DEFAULT_CLAUDE_MODEL);
        expect(new ClusterJudge({ runner }).model).toBe('haiku');
        expect(() => new ClusterJudge({ runner, model: 'opus' })).toThrow(/Unsupported model "opus"/);
        expect(() => new ClusterJudge({ runner, model: 'gemini-3.5-flash-lite' })).toThrow(/Unsupported model/);
    });

    it('passes the prompt, schema, system prompt, and model to the runner and parses its output', async () => {
        const { runner, runStructured } = fakeRunner({
            verdicts: [
                { memory_id: 'a', verdict: 'keep', confidence: 'high' },
                { memory_id: 'b', verdict: 'duplicate', superseded_by: 'a', confidence: 'high' },
            ],
        });
        const members = [member('a', 2_000), member('b', 1_000)];
        const findings = await new ClusterJudge({ runner }).judge(members);

        expect(findings).toEqual([
            { memoryId: 'a', verdict: 'keep', confidence: 'high' },
            { memoryId: 'b', verdict: 'duplicate', supersededBy: 'a', confidence: 'high' },
        ]);
        expect(runStructured).toHaveBeenCalledTimes(1);
        const request = runStructured.mock.calls[0][0] as ClaudeStructuredRequest;
        expect(request.model).toBe('haiku');
        expect(request.prompt).toBe(buildJudgePrompt(members));
        expect(request.schema).toBe(JUDGE_RESPONSE_SCHEMA);
        expect(request.systemPrompt).toMatch(/auditing an AI agent's long-term memory store/);
        expect(request.systemPrompt).toMatch(/At least one\s+memory in every cluster must be 'keep'/);
    });

    it('guarantees one finding per member even when the runner output is sparse', async () => {
        const { runner } = fakeRunner([{ memory_id: 'ghost', verdict: 'duplicate', confidence: 'high' }]);
        const findings = await new ClusterJudge({ runner }).judge([member('a', 2), member('b', 1)]);
        expect(findings).toEqual([
            { memoryId: 'a', verdict: 'keep', confidence: 'low' },
            { memoryId: 'b', verdict: 'keep', confidence: 'low' },
        ]);
    });

    it('propagates runner failures and rejects output with no verdict list', async () => {
        const failing = { runStructured: jest.fn(async () => { throw new Error('Claude Code call failed: overloaded'); }) };
        await expect(new ClusterJudge({ runner: failing as unknown as ClaudeCodeRunner }).judge([member('a', 1)]))
            .rejects.toThrow(/overloaded/);
        const { runner } = fakeRunner({ answer: 'keep' });
        await expect(new ClusterJudge({ runner }).judge([member('a', 1)])).rejects.toThrow(/no verdict list/);
    });
});

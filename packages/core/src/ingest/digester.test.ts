import { ClaudeCodeRunner, ClaudeStructuredRequest, DEFAULT_CLAUDE_MODEL } from '../inference/claude-code';
import {
    ClaudeCodeDigester,
    DIGEST_RESPONSE_SCHEMA,
    GEMINI_DIGEST_MODEL,
    SessionDigester,
    memoryIdForSession,
    parseDigestOutput,
    parseDigestResponse,
    renderDigestMemory,
    buildDigestPrompt,
    toGeminiSchema,
} from './digester';
import { ParsedSession, SessionDigest, SessionMeta } from './types';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: jest.fn() },
    })),
}));

const META: SessionMeta = {
    sessionId: 'abc',
    source: 'factory',
    filePath: '/Users/me/.factory/sessions/proj/abc.jsonl',
    cwd: '/Users/me/project',
    gitBranch: 'main',
    firstTs: Date.parse('2026-03-24T04:04:42.386Z'),
    lastTs: Date.parse('2026-03-24T05:00:00.000Z'),
};

const DIGEST: SessionDigest = {
    title: 'Set up SSE chat streaming',
    whatWasDone: 'Implemented streaming.',
    howToReproduce: ['Run pnpm dev', 'Open /chat'],
    toolsAndServices: ['xcrun notarytool — Apple notarization'],
    credentialsAndConfig: ['Keychain profile `gemdex-notary`'],
    gotchas: ['CORS needs the streaming header'],
};

describe('parseDigestResponse', () => {
    it('parses a full structured response', () => {
        const digest = parseDigestResponse(JSON.stringify({
            title: 'T',
            what_was_done: 'W',
            how_to_reproduce: ['a'],
            tools_and_services: ['b'],
            credentials_and_config: ['c'],
            gotchas: ['d'],
        }));
        expect(digest).toEqual({
            title: 'T',
            whatWasDone: 'W',
            howToReproduce: ['a'],
            toolsAndServices: ['b'],
            credentialsAndConfig: ['c'],
            gotchas: ['d'],
        });
    });

    it('defaults missing arrays to empty', () => {
        const digest = parseDigestResponse(JSON.stringify({ title: 'T', what_was_done: 'W' }));
        expect(digest.howToReproduce).toEqual([]);
        expect(digest.gotchas).toEqual([]);
    });

    it('throws on invalid JSON and missing required fields', () => {
        expect(() => parseDigestResponse('not json')).toThrow(/invalid JSON/);
        expect(() => parseDigestResponse(JSON.stringify({ title: 'T' }))).toThrow(/what_was_done/);
    });
});

describe('renderDigestMemory', () => {
    it('renders header, sections, and the provenance footer', () => {
        const content = renderDigestMemory(DIGEST, META);
        expect(content).toContain('Source: Factory CLI · Repo: /Users/me/project (main) · 2026-03-24');
        expect(content).toContain('## How to reproduce\n1. Run pnpm dev\n2. Open /chat');
        expect(content).toContain('## Tools & services\n- xcrun notarytool — Apple notarization');
        expect(content).toContain('## Credentials & config');
        expect(content).toContain('## Gotchas');
        expect(content).toContain(`Full transcript: ${META.filePath}`);
    });

    it('omits empty sections', () => {
        const content = renderDigestMemory({ ...DIGEST, gotchas: [], credentialsAndConfig: [] }, META);
        expect(content).not.toContain('## Gotchas');
        expect(content).not.toContain('## Credentials & config');
    });
});

describe('memoryIdForSession', () => {
    it('is deterministic across runs', () => {
        expect(memoryIdForSession(META)).toBe('chat:factory:abc');
        expect(memoryIdForSession({ source: 'claude', sessionId: 'x-1' })).toBe('chat:claude:x-1');
    });
});

describe('parseDigestOutput', () => {
    it('validates an already-decoded object', () => {
        expect(parseDigestOutput({ title: ' T ', what_was_done: ' W ', gotchas: ['g', '', 3] })).toEqual({
            title: 'T',
            whatWasDone: 'W',
            howToReproduce: [],
            toolsAndServices: [],
            credentialsAndConfig: [],
            gotchas: ['g'],
        });
    });

    it('rejects non-objects and missing required fields', () => {
        expect(() => parseDigestOutput(null)).toThrow(/non-object/);
        expect(() => parseDigestOutput([{ title: 'T' }])).toThrow(/non-object/);
        expect(() => parseDigestOutput('text')).toThrow(/non-object/);
        expect(() => parseDigestOutput({ title: '  ', what_was_done: 'W' })).toThrow(/title/);
    });
});

describe('DIGEST_RESPONSE_SCHEMA / toGeminiSchema', () => {
    it('is plain JSON Schema with lower-case types', () => {
        expect(DIGEST_RESPONSE_SCHEMA.type).toBe('object');
        expect(DIGEST_RESPONSE_SCHEMA.properties.title.type).toBe('string');
        expect(DIGEST_RESPONSE_SCHEMA.properties.how_to_reproduce.type).toBe('array');
        expect(DIGEST_RESPONSE_SCHEMA.properties.how_to_reproduce.items.type).toBe('string');
        expect(DIGEST_RESPONSE_SCHEMA.required).toEqual(['title', 'what_was_done']);
    });

    it('converts types to Gemini upper-case recursively and keeps other keys', () => {
        const gemini = toGeminiSchema(DIGEST_RESPONSE_SCHEMA);
        const properties = gemini.properties as Record<string, Record<string, unknown>>;
        expect(gemini.type).toBe('OBJECT');
        expect(gemini.required).toEqual(['title', 'what_was_done']);
        expect(properties.title.type).toBe('STRING');
        expect(properties.title.description).toBe(DIGEST_RESPONSE_SCHEMA.properties.title.description);
        expect(properties.gotchas.type).toBe('ARRAY');
        expect(properties.gotchas.items).toEqual({ type: 'STRING' });
        // The source schema is not mutated.
        expect(DIGEST_RESPONSE_SCHEMA.type).toBe('object');
    });

    it('converts enums and nested objects, and tolerates non-objects', () => {
        expect(toGeminiSchema({
            type: 'object',
            properties: { level: { type: 'string', enum: ['a', 'b'] }, nested: { type: 'object', properties: { n: { type: 'number' } } } },
        })).toEqual({
            type: 'OBJECT',
            properties: {
                level: { type: 'STRING', enum: ['a', 'b'] },
                nested: { type: 'OBJECT', properties: { n: { type: 'NUMBER' } } },
            },
        });
        expect(toGeminiSchema(undefined)).toEqual({});
        expect(toGeminiSchema('x')).toEqual({});
    });
});

describe('buildDigestPrompt', () => {
    it('includes context lines and the transcript', () => {
        const prompt = buildDigestPrompt({
            ...META,
            title: 'My session',
            turns: [{ role: 'user', text: 'do the thing' }],
        });
        expect(prompt).toContain('Agent: Factory CLI');
        expect(prompt).toContain('Working directory: /Users/me/project');
        expect(prompt).toContain('Git branch: main');
        expect(prompt).toContain('Session title: My session');
        expect(prompt).toContain('User:\ndo the thing');
    });
});

describe('SessionDigester', () => {
    it('defaults to gemini-3.5-flash-lite and rejects unknown models', () => {
        expect(GEMINI_DIGEST_MODEL).toBe('gemini-3.5-flash-lite');
        expect(new SessionDigester({ apiKey: 'k' }).model).toBe(GEMINI_DIGEST_MODEL);
        expect(() => new SessionDigester({ apiKey: 'k', model: 'gemini-1.5-pro' }))
            .toThrow(/Unsupported digest model/);
        expect(() => new SessionDigester({ apiKey: 'k', model: 'haiku' }))
            .toThrow(/Unsupported digest model/);
    });

    it('digests via generateContent with the Gemini-converted schema and parses the JSON text', async () => {
        const digester = new SessionDigester({ apiKey: 'k' });
        const generateContent = (digester.getClient().models.generateContent as jest.Mock);
        generateContent.mockResolvedValue({
            text: JSON.stringify({ title: 'T', what_was_done: 'W' }),
        });
        const session: ParsedSession = { ...META, turns: [{ role: 'user', text: 'hi' }] };
        const digest = await digester.digest(session);
        expect(digest.title).toBe('T');
        expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: GEMINI_DIGEST_MODEL,
            contents: buildDigestPrompt(session),
            config: expect.objectContaining({
                responseMimeType: 'application/json',
                responseSchema: toGeminiSchema(DIGEST_RESPONSE_SCHEMA),
            }),
        }));
    });

    it('throws when the model returns no text', async () => {
        const digester = new SessionDigester({ apiKey: 'k' });
        (digester.getClient().models.generateContent as jest.Mock).mockResolvedValue({ text: undefined });
        await expect(digester.digest({ ...META, turns: [] })).rejects.toThrow(/empty response/);
    });
});

describe('ClaudeCodeDigester', () => {
    function fakeRunner(output: unknown): { runner: ClaudeCodeRunner; runStructured: jest.Mock } {
        const runStructured = jest.fn(async (_request: ClaudeStructuredRequest) => ({ output, models: ['claude-haiku-4-5'] }));
        return { runner: { runStructured } as unknown as ClaudeCodeRunner, runStructured };
    }

    const session: ParsedSession = { ...META, title: 'Streaming', turns: [{ role: 'user', text: 'wire up SSE' }] };

    it('defaults to haiku and rejects unsupported models', () => {
        const { runner } = fakeRunner({});
        expect(new ClaudeCodeDigester({ runner }).model).toBe(DEFAULT_CLAUDE_MODEL);
        expect(new ClaudeCodeDigester({ runner }).model).toBe('haiku');
        expect(() => new ClaudeCodeDigester({ runner, model: GEMINI_DIGEST_MODEL })).toThrow(/Unsupported model/);
        expect(() => new ClaudeCodeDigester({ runner, model: 'sonnet' })).toThrow(/Unsupported model "sonnet"/);
    });

    it('passes the prompt, JSON schema, system prompt, and model to the runner and parses its output', async () => {
        const { runner, runStructured } = fakeRunner({
            title: 'Set up SSE',
            what_was_done: 'Streamed chat.',
            how_to_reproduce: ['pnpm dev'],
            tools_and_services: ['EventSource'],
        });
        const digest = await new ClaudeCodeDigester({ runner }).digest(session);

        expect(digest).toEqual({
            title: 'Set up SSE',
            whatWasDone: 'Streamed chat.',
            howToReproduce: ['pnpm dev'],
            toolsAndServices: ['EventSource'],
            credentialsAndConfig: [],
            gotchas: [],
        });
        expect(runStructured).toHaveBeenCalledTimes(1);
        const request = runStructured.mock.calls[0][0] as ClaudeStructuredRequest;
        expect(request.model).toBe('haiku');
        expect(request.prompt).toBe(buildDigestPrompt(session));
        // Claude Code takes the plain JSON Schema, not the Gemini conversion.
        expect(request.schema).toBe(DIGEST_RESPONSE_SCHEMA);
        expect(request.systemPrompt).toMatch(/distill a coding-agent chat transcript/);
    });

    it('rejects runner output that is not a valid digest', async () => {
        await expect(new ClaudeCodeDigester({ runner: fakeRunner({ title: 'T' }).runner }).digest(session))
            .rejects.toThrow(/what_was_done/);
        await expect(new ClaudeCodeDigester({ runner: fakeRunner(['x']).runner }).digest(session))
            .rejects.toThrow(/non-object/);
    });

    it('propagates runner failures', async () => {
        const runner = { runStructured: jest.fn(async () => { throw new Error('Claude Code call timed out'); }) };
        await expect(new ClaudeCodeDigester({ runner: runner as unknown as ClaudeCodeRunner }).digest(session))
            .rejects.toThrow(/timed out/);
    });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    MIN_SESSION_CHARS,
    parseSessionFile,
    renderTranscript,
    stripSystemReminders,
} from './transcript-parser';

const FILLER = 'x'.repeat(MIN_SESSION_CHARS);

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-parser-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, records: unknown[]): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
    return filePath;
}

describe('parseSessionFile — Claude dialect', () => {
    it('extracts turns, metadata, and compact tool-use commands', () => {
        const filePath = writeJsonl('abc-123.jsonl', [
            { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-14T15:01:32.078Z' },
            {
                type: 'user',
                timestamp: '2026-05-14T15:01:32.088Z',
                sessionId: 'abc-123',
                cwd: '/Users/me/agent',
                gitBranch: 'main',
                message: { role: 'user', content: `Set up notarization. ${FILLER}` },
            },
            {
                type: 'assistant',
                timestamp: '2026-05-14T15:02:00.000Z',
                sessionId: 'abc-123',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'pondering…' },
                        { type: 'text', text: 'Running the notary tool now.' },
                        {
                            type: 'tool_use',
                            id: 't1',
                            name: 'Bash',
                            input: { command: 'xcrun notarytool submit app.zip --keychain-profile gemdex' },
                        },
                    ],
                },
            },
            {
                type: 'user',
                timestamp: '2026-05-14T15:02:05.000Z',
                message: {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: invalid credentials\nmore detail' },
                    ],
                },
            },
        ]);

        const parsed = parseSessionFile(filePath, 'claude');
        expect(parsed).not.toBeNull();
        expect(parsed!.sessionId).toBe('abc-123');
        expect(parsed!.cwd).toBe('/Users/me/agent');
        expect(parsed!.gitBranch).toBe('main');
        expect(parsed!.firstTs).toBe(Date.parse('2026-05-14T15:01:32.088Z'));
        expect(parsed!.lastTs).toBe(Date.parse('2026-05-14T15:02:05.000Z'));
        expect(parsed!.turns).toHaveLength(3);
        expect(parsed!.turns[1].text).toContain('Running the notary tool now.');
        expect(parsed!.turns[1].text).toContain('$ xcrun notarytool submit app.zip --keychain-profile gemdex');
        expect(parsed!.turns[2].text).toBe('error: Error: invalid credentials');
    });

    it('skips sidechain events', () => {
        const filePath = writeJsonl('side.jsonl', [
            { type: 'user', isSidechain: true, message: { role: 'user', content: FILLER } },
            { type: 'user', message: { role: 'user', content: `real ${FILLER}` } },
        ]);
        const parsed = parseSessionFile(filePath, 'claude');
        expect(parsed!.turns).toHaveLength(1);
        expect(parsed!.turns[0].text).toContain('real');
    });
});

describe('parseSessionFile — Factory dialect', () => {
    it('reads session_start metadata and message events', () => {
        const filePath = writeJsonl('f1.jsonl', [
            {
                type: 'session_start',
                id: 'factory-id-1',
                title: 'Fix streaming bug',
                cwd: '/Users/me/project',
            },
            {
                type: 'message',
                timestamp: '2026-03-24T04:04:42.386Z',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: `<system-reminder>noise</system-reminder>Fix the bug please. ${FILLER}` },
                    ],
                },
            },
            {
                type: 'message',
                timestamp: '2026-03-24T04:05:00.000Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Done.' },
                        { type: 'tool_use', name: 'Execute', input: { command: 'pnpm test' } },
                    ],
                },
            },
        ]);
        const parsed = parseSessionFile(filePath, 'factory');
        expect(parsed!.sessionId).toBe('factory-id-1');
        expect(parsed!.title).toBe('Fix streaming bug');
        expect(parsed!.cwd).toBe('/Users/me/project');
        expect(parsed!.turns[0].text).not.toContain('system-reminder');
        expect(parsed!.turns[0].text).toContain('Fix the bug please.');
        expect(parsed!.turns[1].text).toContain('$ pnpm test');
    });
});

describe('parseSessionFile — edge cases', () => {
    it('returns null for trivial sessions', () => {
        const filePath = writeJsonl('trivial.jsonl', [
            { type: 'user', message: { role: 'user', content: 'hi' } },
        ]);
        expect(parseSessionFile(filePath, 'claude')).toBeNull();
    });

    it('tolerates corrupt lines', () => {
        const filePath = path.join(dir, 'corrupt.jsonl');
        fs.writeFileSync(filePath, `not json\n${JSON.stringify({
            type: 'user', message: { role: 'user', content: FILLER },
        })}\n{truncated`, 'utf8');
        const parsed = parseSessionFile(filePath, 'claude');
        expect(parsed!.turns).toHaveLength(1);
    });

    it('renders edit tool calls as edit: <path> lines', () => {
        const filePath = writeJsonl('edits.jsonl', [
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: FILLER },
                        { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts', old_str: 'a', new_str: 'b' } },
                    ],
                },
            },
        ]);
        const parsed = parseSessionFile(filePath, 'claude');
        expect(parsed!.turns[0].text).toContain('edit: /src/app.ts');
    });
});

describe('stripSystemReminders', () => {
    it('removes all reminder blocks', () => {
        const input = 'before <system-reminder>a</system-reminder> middle <system-reminder>b\nc</system-reminder> after';
        expect(stripSystemReminders(input)).toBe('before  middle  after');
    });
});

describe('renderTranscript', () => {
    it('joins turns with role labels', () => {
        const text = renderTranscript([
            { role: 'user', text: 'hello' },
            { role: 'assistant', text: 'world' },
        ]);
        expect(text).toBe('User:\nhello\n\nAssistant:\nworld');
    });

    it('elides the middle when over the cap', () => {
        const turns = [{ role: 'user' as const, text: 'a'.repeat(1000) }];
        const rendered = renderTranscript(turns, 500);
        expect(rendered).toContain('[… transcript elided …]');
        expect(rendered.length).toBeLessThan(600);
    });
});

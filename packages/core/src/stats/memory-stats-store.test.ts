import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStatsStore } from './memory-stats-store';

let dir: string;
let filePath: string;
let store: MemoryStatsStore;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-stats-store-'));
    filePath = path.join(dir, '.gemdex', 'stats.json');
    store = new MemoryStatsStore(filePath);
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStatsStore', () => {
    it('returns undefined for a memory with no recorded stats', () => {
        expect(store.get('unknown-id')).toBeUndefined();
    });

    it('recordRecall bumps recallCount and lastRecalledAt for every surfaced id', () => {
        store.recordRecall(['a', 'b'], 1_000);
        expect(store.get('a')).toEqual({ recallCount: 1, lastRecalledAt: 1_000, workedCount: 0, failedCount: 0, staleCount: 0 });
        expect(store.get('b')).toEqual({ recallCount: 1, lastRecalledAt: 1_000, workedCount: 0, failedCount: 0, staleCount: 0 });

        store.recordRecall(['a'], 2_000);
        expect(store.get('a')?.recallCount).toBe(2);
        expect(store.get('a')?.lastRecalledAt).toBe(2_000);
        // 'b' untouched by the second call.
        expect(store.get('b')?.recallCount).toBe(1);
    });

    it('recordRecall is a no-op for an empty id list (no file created)', () => {
        store.recordRecall([]);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('recordOutcome tallies worked/failed/stale and sets lastOutcome', () => {
        store.recordOutcome('m1', 'worked', undefined, 1_000);
        store.recordOutcome('m1', 'worked', undefined, 2_000);
        const afterWorked = store.recordOutcome('m1', 'failed', 'the flags changed', 3_000);

        expect(afterWorked.workedCount).toBe(2);
        expect(afterWorked.failedCount).toBe(1);
        expect(afterWorked.staleCount).toBe(0);
        expect(afterWorked.lastOutcome).toEqual({ outcome: 'failed', at: 3_000, note: 'the flags changed' });
        expect(store.get('m1')).toEqual(afterWorked);
    });

    it('recordOutcome without a note omits the note field', () => {
        const stats = store.recordOutcome('m1', 'stale', undefined, 1_000);
        expect(stats.lastOutcome).toEqual({ outcome: 'stale', at: 1_000 });
        expect('note' in stats.lastOutcome!).toBe(false);
    });

    it('recordOutcome trims and caps a note at 500 characters', () => {
        const padded = `  ${'x'.repeat(600)}  `;
        const stats = store.recordOutcome('m1', 'worked', padded, 1_000);
        expect(stats.lastOutcome?.note).toHaveLength(500);
        expect(stats.lastOutcome?.note).toBe('x'.repeat(500));
    });

    it('recordOutcome with a whitespace-only note omits the note field', () => {
        const stats = store.recordOutcome('m1', 'worked', '   ', 1_000);
        expect(stats.lastOutcome).toEqual({ outcome: 'worked', at: 1_000 });
    });

    it('record/read round-trips through a fresh instance over the same file', () => {
        store.recordRecall(['a'], 500);
        store.recordOutcome('a', 'worked', 'notes here', 600);

        const fresh = new MemoryStatsStore(filePath);
        expect(fresh.get('a')).toEqual({
            recallCount: 1,
            lastRecalledAt: 500,
            workedCount: 1,
            failedCount: 0,
            staleCount: 0,
            lastOutcome: { outcome: 'worked', at: 600, note: 'notes here' },
        });
    });

    it('creates the parent directory on first write', () => {
        expect(fs.existsSync(path.dirname(filePath))).toBe(false);
        store.recordRecall(['a']);
        expect(fs.existsSync(path.dirname(filePath))).toBe(true);
        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('persists atomically: no leftover .tmp files after a write', () => {
        store.recordRecall(['a']);
        store.recordOutcome('a', 'worked');
        const entries = fs.readdirSync(path.dirname(filePath));
        expect(entries).toEqual(['stats.json']);
    });

    it('is tolerant of a missing file (starts fresh, does not throw)', () => {
        expect(fs.existsSync(filePath)).toBe(false);
        expect(() => store.get('a')).not.toThrow();
        expect(store.get('a')).toBeUndefined();
    });

    it('is tolerant of a corrupt/foreign file (starts fresh, does not throw)', () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'not valid json {{{', 'utf8');
        expect(() => store.get('a')).not.toThrow();
        expect(store.get('a')).toBeUndefined();

        // A write after a corrupt read heals the file with a clean ledger.
        store.recordRecall(['a'], 42);
        expect(store.get('a')?.recallCount).toBe(1);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(raw.version).toBe(1);
    });

    it('is tolerant of a well-formed-but-wrong-shape file (starts fresh)', () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ version: 2, memories: {} }), 'utf8');
        expect(store.get('a')).toBeUndefined();
    });

    it('propagates a system read error instead of silently starting fresh', () => {
        // A directory at the stats path triggers a system error (EISDIR) on
        // read — distinct from a corrupt/foreign file. This must NOT be
        // swallowed into an empty ledger, since a later write() would then
        // clobber whatever was actually there once the transient failure clears.
        fs.mkdirSync(filePath, { recursive: true });
        expect(() => store.get('a')).toThrow();
    });

    it('removeStats drops all stats for an id and is harmless if absent', () => {
        store.recordRecall(['a', 'b'], 1);
        store.removeStats('a');
        expect(store.get('a')).toBeUndefined();
        expect(store.get('b')).toBeDefined();

        // No-op on an id with no stats at all.
        expect(() => store.removeStats('does-not-exist')).not.toThrow();
    });

    it('defaults to ~/.gemdex/stats.json when no path is given and GEMDEX_STATS_PATH is unset', () => {
        const savedEnv = process.env.GEMDEX_STATS_PATH;
        delete process.env.GEMDEX_STATS_PATH;
        try {
            const defaultStore = new MemoryStatsStore();
            expect(defaultStore.filePath).toBe(path.join(os.homedir(), '.gemdex', 'stats.json'));
        } finally {
            if (savedEnv === undefined) delete process.env.GEMDEX_STATS_PATH;
            else process.env.GEMDEX_STATS_PATH = savedEnv;
        }
    });

    it('honors GEMDEX_STATS_PATH when no explicit path is given', () => {
        const savedEnv = process.env.GEMDEX_STATS_PATH;
        const overridePath = path.join(dir, 'custom-stats.json');
        process.env.GEMDEX_STATS_PATH = overridePath;
        try {
            const envStore = new MemoryStatsStore();
            expect(envStore.filePath).toBe(overridePath);
            envStore.recordRecall(['a'], 1);
            expect(fs.existsSync(overridePath)).toBe(true);
        } finally {
            if (savedEnv === undefined) delete process.env.GEMDEX_STATS_PATH;
            else process.env.GEMDEX_STATS_PATH = savedEnv;
        }
    });

    it('an explicit constructor filePath takes priority over GEMDEX_STATS_PATH', () => {
        const savedEnv = process.env.GEMDEX_STATS_PATH;
        process.env.GEMDEX_STATS_PATH = path.join(dir, 'should-not-be-used.json');
        try {
            const explicitStore = new MemoryStatsStore(filePath);
            expect(explicitStore.filePath).toBe(filePath);
        } finally {
            if (savedEnv === undefined) delete process.env.GEMDEX_STATS_PATH;
            else process.env.GEMDEX_STATS_PATH = savedEnv;
        }
    });
});

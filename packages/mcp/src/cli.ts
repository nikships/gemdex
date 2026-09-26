import * as fs from 'node:fs';
import {
    attachTranscriptToRecord,
    checkClaudeCode,
    ClaudeCodeReadiness,
    DEFAULT_CLAUDE_MODEL,
    hasTranscriptAttachment,
    INFERENCE_MODELS,
    INFERENCE_PRICING_AS_OF,
    IngestManager,
    IngestSourceFolder,
    MemoryBackend,
    antigravityPresetFolder,
    claudePresetFolder,
    codexPresetFolder,
    factoryPresetFolder,
} from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig } from './config.js';
import { errorMessage } from './errors.js';
import { createMemoryBackend } from './memory.js';
import { installLocalModel, localModelStatusWithLegacy, migrateLegacyMemories } from './local-model.js';

interface CliIo {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
}

interface CliDependencies {
    store?: ClientConfigStore;
    io?: CliIo;
    /** Local backend, used by ingest-history and backfill-transcripts. */
    createBackend?: () => MemoryBackend;
    createIngestManager?: () => IngestManager;
    /** Overridable so tests never spawn the real Claude Code CLI. */
    checkClaudeCode?: () => Promise<ClaudeCodeReadiness>;
}

const defaultIo: CliIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
};

function usage(): string {
    return `Gemdex local setup and maintenance

Usage:
  gemdex install
  gemdex migrate
  gemdex status
  gemdex backfill-transcripts [--force] [--dry-run]
  gemdex ingest-history [--source claude|factory|codex|antigravity|PATH]... [--model MODEL] [--dry-run]

install downloads the managed Python/MLX runtime and the pinned BGE-M3 model
(Apple Silicon only, ~600 MB). It is the only step that downloads anything.

migrate re-embeds memories saved by earlier Gemini-based releases into the
local model. Their text, titles, timestamps and attachment files are kept.

backfill-transcripts re-imports digest memories that only have a path footer,
attaching the full transcript blob. Missing files are skipped with a message.

ingest-history distills coding-agent chat transcripts (Claude Code, Factory
CLI, Codex, Antigravity, or any folder of .jsonl sessions) into one memory per
session (digest text + full transcript as a non-embedded attachment). Digests
are written by your local Claude Code CLI (claude -p with Haiku), using the
login Claude Code already has. Only never-before-ingested sessions are
processed; previously ingested sessions are never reprocessed. Defaults to
detected presets. --dry-run prints the scan + cost estimate.
`;
}

function requireArg(args: string[], index: number, label: string): string {
    const value = args[index]?.trim();
    if (!value) throw new Error(`${label} is required.`);
    return value;
}

function optionValue(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    return requireArg(args, index + 1, `${name} value`);
}

interface BackfillTranscriptsResult {
    attached: number;
    already: number;
    missing: number;
    noPath: number;
    failed: number;
}

/**
 * Re-import digests that only have a path footer, attaching the transcript file
 * when present. Idempotent: already-attached digests are skipped unless force.
 */
async function backfillTranscripts(
    backend: MemoryBackend,
    io: CliIo,
    options: { force?: boolean; dryRun?: boolean } = {},
): Promise<BackfillTranscriptsResult> {
    // Never use exportAll() here — export inlines every transcript as
    // base64 and multi-hundred-MB pools blow V8 string limits ("Invalid string
    // length"). List summaries + per-id get() only returns metadata + content.
    const summaries = await backend.list();
    const candidates = summaries.filter((summary) => summary.id.startsWith('chat:'));
    const result: BackfillTranscriptsResult = {
        attached: 0, already: 0, missing: 0, noPath: 0, failed: 0,
    };
    let index = 0;
    for (const summary of candidates) {
        index += 1;
        let memory;
        try {
            memory = await backend.get(summary.id);
        } catch (error) {
            result.failed += 1;
            io.stderr(`Failed ${summary.id}: ${errorMessage(error)}\n`);
            continue;
        }
        if (!memory) {
            result.failed += 1;
            io.stderr(`Failed ${summary.id}: not found\n`);
            continue;
        }

        if (!options.force && hasTranscriptAttachment(memory.attachments)) {
            result.already += 1;
            continue;
        }

        // Build a metadata-only export record (no attachment bytes). Cleaned
        // transcript is read from the local path footed in content.
        const attached = attachTranscriptToRecord(
            {
                id: memory.id,
                title: memory.title,
                content: memory.content,
                createdAt: memory.createdAt,
                updatedAt: memory.updatedAt,
            },
            { force: options.force === true },
        );
        if (attached.status === 'already') {
            result.already += 1;
            continue;
        }
        if (attached.status === 'no_path') {
            result.noPath += 1;
            continue;
        }
        if (attached.status === 'missing') {
            result.missing += 1;
            io.stderr(
                `Missing transcript for ${memory.id}` +
                (attached.filePath ? `: ${attached.filePath}` : '') + `\n`,
            );
            continue;
        }

        if (options.dryRun) {
            result.attached += 1;
            io.stdout(`[dry-run] would attach transcript to ${memory.id}\n`);
            continue;
        }

        try {
            const imported = await backend.importRecords([attached.record]);
            if (imported.imported === 1) {
                result.attached += 1;
            } else {
                result.failed += 1;
                const detail = imported.errors[0]?.error;
                io.stderr(`Failed ${memory.id}${detail ? `: ${detail}` : ''}\n`);
            }
        } catch (error) {
            result.failed += 1;
            io.stderr(`Failed ${memory.id}: ${errorMessage(error)}\n`);
        }

        if (index % 25 === 0 || index === candidates.length) {
            io.stdout(
                `Progress ${index}/${candidates.length} — ` +
                `attached ${result.attached}, already ${result.already}, ` +
                `missing ${result.missing}, noPath ${result.noPath}, failed ${result.failed}\n`,
            );
        }
    }
    return result;
}


function describeClaude(readiness: ClaudeCodeReadiness): string {
    if (readiness.status === 'ready') {
        return `ready${readiness.version ? ` (${readiness.version})` : ''}${readiness.path ? ` at ${readiness.path}` : ''}`;
    }
    return `${readiness.status}${readiness.message ? ` — ${readiness.message}` : ''}`;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number | null> {
    const store = dependencies.store ?? new ClientConfigStore();
    const io = dependencies.io ?? defaultIo;
    const createBackend = dependencies.createBackend
        ?? (() => createMemoryBackend(createConfig((name) => store.getEnv(name)), store.rootDir));

    const [command] = args;
    const CLI_COMMANDS = ['install', 'migrate', 'status', 'backfill-transcripts', 'ingest-history'];
    if (!CLI_COMMANDS.includes(command)) return null;

    try {
        if (command === 'install') {
            if (args.length !== 1) throw new Error('Usage: npx gemdex-mcp install');
            await installLocalModel(store, (message) => io.stderr(`${message}\n`));
            io.stdout('Local model installed. Run npx gemdex-mcp migrate if you have memories from a Gemini-based Gemdex release.\n');
            return 0;
        }

        if (command === 'migrate') {
            if (args.length !== 1) throw new Error('Usage: npx gemdex-mcp migrate');
            await migrateLegacyMemories(store, (completed, total) => io.stderr(`Migrating memories: ${completed}/${total}\n`));
            io.stdout('Migration complete. Every memory is now searchable with the local model.\n');
            return 0;
        }

        if (command === 'status') {
            const model = await localModelStatusWithLegacy(store);
            io.stdout(`Store: ${store.getEnv('LANCEDB_PATH') ?? '~/.gemdex/lance'}\n`);
            io.stdout(`Local model: ${model.status} (${model.model})\n`);
            if ((model.legacyMemories ?? 0) > 0) {
                io.stdout(`Legacy memories awaiting migration: ${model.legacyMemories} — run npx gemdex-mcp migrate\n`);
            }
            const claude = await (dependencies.checkClaudeCode ?? (() => checkClaudeCode()))();
            io.stdout(`Claude Code (ingestion + hygiene): ${describeClaude(claude)}\n`);
            return 0;
        }

        if (command === 'ingest-history') {
            return await runIngestHistory(args.slice(1), io, createBackend, dependencies);
        }

        if (command === 'backfill-transcripts') {
            const force = args.includes('--force');
            const dryRun = args.includes('--dry-run');
            const result = await backfillTranscripts(createBackend(), io, { force, dryRun });
            io.stdout(
                'Backfill transcripts' +
                (dryRun ? ' (dry-run)' : '') + `:\n` +
                `  attached: ${result.attached}\n` +
                `  already had transcript: ${result.already}\n` +
                `  missing file: ${result.missing}\n` +
                `  no path footer: ${result.noPath}\n` +
                `  failed: ${result.failed}\n`,
            );
            return result.failed === 0 ? 0 : 1;
        }

        io.stderr(usage());
        return 1;
    } catch (error) {
        io.stderr(`Error: ${errorMessage(error)}\n`);
        return 1;
    }
}

/** Collect every `--source` value: presets by name, anything else as a custom path. */
function parseIngestSources(args: string[]): IngestSourceFolder[] {
    const folders: IngestSourceFolder[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--source') continue;
        const value = requireArg(args, i + 1, '--source value');
        if (value === 'claude') {
            folders.push(claudePresetFolder());
        } else if (value === 'factory') {
            folders.push(factoryPresetFolder());
        } else if (value === 'codex') {
            folders.push(codexPresetFolder());
        } else if (value === 'antigravity') {
            folders.push(antigravityPresetFolder());
        } else {
            folders.push({ source: 'custom', path: value });
        }
    }
    if (folders.length > 0) return folders;
    // Default: all built-in presets, when their folders exist.
    const presets = [claudePresetFolder(), factoryPresetFolder(), codexPresetFolder(), antigravityPresetFolder()]
        .filter((preset) => fs.existsSync(preset.path));
    if (presets.length === 0) {
        throw new Error('No session folders found. Pass --source claude|factory|codex|antigravity|<path>.');
    }
    return presets;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

/** Scan → estimate → digest (Claude Code) → upsert into the local store. */
async function runIngestHistory(
    args: string[],
    io: CliIo,
    createBackend: () => MemoryBackend,
    dependencies: CliDependencies,
): Promise<number> {
    const model = optionValue(args, '--model') ?? DEFAULT_CLAUDE_MODEL;
    if (!INFERENCE_MODELS[model]) {
        throw new Error(`Unsupported model "${model}". Supported: ${Object.keys(INFERENCE_MODELS).join(', ')}`);
    }
    const dryRun = args.includes('--dry-run');
    const manager = dependencies.createIngestManager?.() ?? new IngestManager();

    const folders = parseIngestSources(args);
    const scan = manager.scan(folders);
    io.stdout(
        `Sessions — new: ${scan.processableFiles.length}, ` +
        `previously ingested and changed (skipped): ${scan.buckets.changedFiles.length}, ` +
        `up-to-date: ${scan.buckets.upToDate.length}, active (skipped): ${scan.buckets.skippedActive.length}\n`,
    );
    if (scan.skippedTrivialFiles.length > 0) {
        io.stdout(`Skipped trivial candidates: ${scan.skippedTrivialFiles.length}\n`);
    }
    if (scan.buckets.changedFiles.length > 0) {
        io.stdout('Previously ingested sessions are never reprocessed.\n');
    }
    if (scan.pendingCount === 0) {
        io.stdout('Nothing to ingest.\n');
        return 0;
    }
    io.stdout(`Estimated input tokens: ~${scan.estimatedInputTokens.toLocaleString()}\n`);
    io.stdout(`Cost at Anthropic API list price (as of ${INFERENCE_PRICING_AS_OF}):\n`);
    for (const estimate of scan.estimates) {
        const marker = estimate.model === model ? '*' : ' ';
        io.stdout(`  ${marker} ${estimate.model.padEnd(12)} ${formatUsd(estimate.usd)}\n`);
    }
    io.stdout('  A Claude subscription login is not billed per token; usage counts toward your plan limits.\n');
    if (dryRun) return 0;

    const claude = await (dependencies.checkClaudeCode ?? (() => checkClaudeCode()))();
    if (claude.status !== 'ready') {
        throw new Error(`Claude Code is not ready: ${describeClaude(claude)}`);
    }

    const target = createBackend();
    const ticker = setInterval(() => {
        const progress = manager.getProgress();
        io.stderr(`\r[ingest] ${progress.processed + progress.failed}/${progress.total} (failed: ${progress.failed})  `);
    }, 1000);
    try {
        const progress = await manager.run({ folders, model }, target);
        io.stderr('\n');
        io.stdout(
            `Done — Ingested: ${progress.processed}, Failed: ${progress.failed}, ` +
            `Skipped (trivial/unchanged): ${progress.skipped}.\n`,
        );
        return progress.failed === 0 ? 0 : 1;
    } finally {
        clearInterval(ticker);
    }
}

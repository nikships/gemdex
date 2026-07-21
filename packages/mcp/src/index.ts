#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryBackend, MemoryStatsStore } from "gemdex-core";

import { createConfig, logConfigurationSummary, showHelpMessage, GemdexConfig } from "./config.js";
import { createMemoryBackend } from "./memory.js";
import { MemoryToolHandlers } from "./handlers.js";
import { runServe } from "./serve.js";
import { MCP_TOOL_NAMES } from "./tool-names.js";
import { runCli } from "./cli.js";

const SAVE_MEMORY_DESCRIPTION = `
Persist a new memory to the user's global, durable memory layer.

🎯 **When to use**: ONLY when the user explicitly asks you to remember or save
something ("save this to memory", "remember that…", "store these credentials").
Never capture proactively.

Behavior: the content is chunked, embedded via Gemini, and stored globally
(searchable from every repo and session). Returns the new memory id.

Multimodal: optionally pass \`attachments\` (image/audio/video/PDF) to embed
media alongside the text. Each attachment is either a local file \`path\`
(preferred — the server reads + encodes the bytes, so you don't emit base64) or
inline base64 \`data\`. Requires the gemini-embedding-2 model. Either \`content\`
or at least one attachment is required.

If the response includes a "⚠ similar existing memories already stored" block,
the store found near-duplicate/conflicting memories already there — read it and
consolidate with \`update_memory\` (or confirm with the user which should win)
rather than leaving both.
`;

const RECALL_DESCRIPTION = `
Retrieve memories from the user's global memory layer by natural-language query
and/or inline media (image / audio / video / PDF).

🎯 **When to use**: ONLY when the user points you at memory ("check your memory
layer", "how do we usually do X", "what were those credentials", "find the
memory that matches this screenshot"). Never recall unprompted.

Behavior: hybrid semantic + BM25 search over text, plus a media-similarity
branch for each query attachment, fused by relevance. Returns the FULL matching
memories (never fragments). A query attachment is either a local file \`path\`
(preferred — the server reads + encodes the bytes) or inline base64 \`data\`.
Either \`query\` or at least one attachment is required; recall-by-media requires
the gemini-embedding-2 model.

Each hit reports its relative age (\`updated: …\`) and any attachments
(\`kind (id …)\`) so you can judge freshness and know media exists; fetch
attachment bytes from the desktop sidecar at
\`GET /memories/:id/attachments/:attachmentId\`. Pass \`detail: "summary"\` to
get title + preview + score only (cheap to scan many hits), then re-run with
\`detail: "full"\` (the default) for the complete content you need.

When available, each hit also shows a "track record" line (recalled/worked/
failed/stale counts from prior \`report_outcome\` calls) so you can judge how
trustworthy this memory has been in practice — a \`⚠\` prefix means it has
failed or gone stale before. Setting \`GEMDEX_TRUST_RANKING=true\` additionally
re-ranks results by that track record (off by default; ranking stays pure
relevance until you opt in).

If a recalled memory includes a "Full transcript:" path (often a .jsonl session
log) and the summary does not answer the user's question with enough detail,
read that transcript directly before concluding. Treat transcript paths as
supporting evidence for the memory, especially when the user asks for exact
prior code, commands, comparisons, or session details.
`;

const LIST_MEMORIES_DESCRIPTION = `
Browse the user's global memory layer: list stored memories newest-first, each
as a compact title + id + relative age + preview (no embedding/search).

🎯 **When to use**: when the user wants to see what's stored ("what do you have
in memory?", "list your memories about deploys") or when you need a memory's
exact \`id\` to pass to \`update_memory\` and a fuzzy \`recall\` isn't precise.
Like the other tools, use it only when the user points you at the memory layer.

Behavior: returns lightweight summaries (content truncated to a preview), not
full content — use \`recall\` for relevance-ranked full memories. Optional
\`filter\` is a case-insensitive substring matched against title + preview (a
literal filter, NOT semantic search). \`limit\` defaults to 50 (max 200).
`;

const UPDATE_MEMORY_DESCRIPTION = `
Revise an existing memory in place, identified by its id.

🎯 **When to use**: when the user asks to update/correct a stored memory
("the notarization step changed — update that memory"). Get the id from a prior
save_memory or recall result.

Two ways to change the text:
- \`edits\`: targeted find-and-replace — preferred for large memories. Pass an
  array of \`{ oldText, newText, replaceAll? }\`; you emit only the changed
  snippets instead of resending the whole note. Each \`oldText\` must match
  exactly and be unique (set \`replaceAll: true\` to change every occurrence).
- \`content\`: full replacement of the text. Use for small memories or rewrites.
\`content\` and \`edits\` are mutually exclusive.

Behavior: re-chunks and re-embeds the resulting content under the same id.
Omitted fields are preserved — leave out \`content\`/\`edits\` to keep the prior
text, leave out \`attachments\` to keep the prior media (pass \`attachments: []\`
to clear it). Each attachment is either a local file \`path\` (preferred) or
inline base64 \`data\`. There is no delete via MCP — deletion is a human action
in the desktop app.
`;

const REPORT_OUTCOME_DESCRIPTION = `
Report how acting on a recalled memory went, so the memory layer learns which
memories are trustworthy.

🎯 **When to use**: right after you used a recalled memory and the outcome is
clear — \`worked\` (followed it and it was correct), \`failed\` (its information
was wrong or broken), \`stale\` (clearly outdated, e.g. rotated credentials or
moved paths). One call per memory actually used; do not report memories you
merely saw in results. This is meta-feedback on the memory layer itself and is
the one gemdex tool you should call without being asked, whenever a clear
outcome exists.

Recorded locally in a per-client ledger keyed by memory id (not written back
into the memory itself). With \`GEMDEX_TRUST_RANKING=true\` it also adjusts
future \`recall\` ranking — proven memories rank higher, memories that have
burned the agent rank lower.
`;

// JSON-schema fragment for the optional media array shared by save_memory /
// recall / update_memory. Each item is EITHER a local file `path` (preferred
// for agents — the server reads + base64-encodes it, so no megabytes of base64
// land in tool-call args) OR inline base64 `data`.
const ATTACHMENTS_SCHEMA = {
    type: "array",
    description:
        "Optional media to embed. Each item is either a local file 'path' (preferred — the " +
        "server reads the bytes off disk; mimeType is inferred from the extension) or inline " +
        "base64 'data' with a 'mimeType'. Requires the gemini-embedding-2 model. " +
        "Limits: ≤6 images, ≤1 PDF, ≤1 audio, ≤1 video per memory.",
    items: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Absolute (or ~/cwd-relative) path to a local media file. Preferred over 'data'. Mutually exclusive with 'data'.",
            },
            mimeType: {
                type: "string",
                description: "image/png, image/jpeg, audio/mp3, audio/wav, video/mp4, video/quicktime, or application/pdf. Required with 'data'; optional with 'path' (inferred from the extension).",
            },
            data: {
                type: "string",
                description: "Base64-encoded bytes of the attachment. Mutually exclusive with 'path'.",
            },
            caption: {
                type: "string",
                description: "Optional text describing this attachment; backs the BM25 (keyword) branch for it.",
            },
        },
        anyOf: [
            { required: ["path"] },
            { required: ["data", "mimeType"] },
        ],
    },
} as const;

class GemdexMemoryServer {
    private server: Server;
    private handlers: MemoryToolHandlers;

    constructor(config: GemdexConfig) {
        this.server = new Server(
            { name: config.name, version: config.version },
            { capabilities: { tools: {} } },
        );

        const store: MemoryBackend = createMemoryBackend(config);
        const statsStore = new MemoryStatsStore();
        this.handlers = new MemoryToolHandlers(store, statsStore);

        this.setupTools();
    }

    private setupTools() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: MCP_TOOL_NAMES[0],
                    description: SAVE_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: {
                                type: "string",
                                description: "The memory content. A one-line fact or a long playbook — anything. Recommended; optional only when attachments are provided.",
                            },
                            title: {
                                type: "string",
                                description: "Optional human-readable name. Auto-derived from content if omitted.",
                            },
                            attachments: ATTACHMENTS_SCHEMA,
                        },
                        required: [],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[1],
                    description: RECALL_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Natural-language description of what to recall. Optional when attachments are provided.",
                            },
                            limit: {
                                type: "number",
                                description: "Max number of memories to return.",
                                default: 10,
                                maximum: 50,
                            },
                            detail: {
                                type: "string",
                                enum: ["summary", "full"],
                                description: "'full' (default) returns each memory's complete content; 'summary' returns only a short preview per hit — cheaper to scan many results before pulling full content.",
                                default: "full",
                            },
                            attachments: ATTACHMENTS_SCHEMA,
                        },
                        required: [],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[2],
                    description: UPDATE_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "The id of the memory to revise (from save_memory or recall).",
                            },
                            content: {
                                type: "string",
                                description: "Full replacement text. Omit to keep the existing text. Mutually exclusive with 'edits'; prefer 'edits' for large memories.",
                            },
                            edits: {
                                type: "array",
                                description:
                                    "Targeted find-and-replace edits applied to the current content — the preferred way to change part of a large memory without resending the whole note. Applied in order. Mutually exclusive with 'content'.",
                                items: {
                                    type: "object",
                                    properties: {
                                        oldText: {
                                            type: "string",
                                            description: "Exact substring to find (literal, not regex). Must be unique unless 'replaceAll' is true.",
                                        },
                                        newText: {
                                            type: "string",
                                            description: "Text to replace 'oldText' with. Must differ from 'oldText'.",
                                        },
                                        replaceAll: {
                                            type: "boolean",
                                            description: "Replace every occurrence of 'oldText'. Defaults to false (requires a unique match).",
                                        },
                                    },
                                    required: ["oldText", "newText"],
                                },
                            },
                            title: {
                                type: "string",
                                description: "Optional new title. Omit to keep the existing title.",
                            },
                            attachments: ATTACHMENTS_SCHEMA,
                        },
                        required: ["id"],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[3],
                    description: LIST_MEMORIES_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            filter: {
                                type: "string",
                                description: "Optional case-insensitive substring matched against each memory's title and preview (literal, not semantic). Omit to list everything.",
                            },
                            limit: {
                                type: "number",
                                description: "Max number of memories to return.",
                                default: 50,
                                maximum: 200,
                            },
                        },
                        required: [],
                    },
                },
                {
                    name: MCP_TOOL_NAMES[4],
                    description: REPORT_OUTCOME_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "The id of the memory you acted on (from a prior save_memory or recall result).",
                            },
                            outcome: {
                                type: "string",
                                enum: ["worked", "failed", "stale"],
                                description: "'worked' — followed it and it was correct. 'failed' — its information was wrong or broken. 'stale' — clearly outdated (e.g. rotated credentials, moved paths).",
                            },
                            note: {
                                type: "string",
                                description: "Optional one-line note on what happened (e.g. \"notarytool flags changed; --wait no longer accepts --timeout\"). Capped at 500 characters.",
                            },
                        },
                        required: ["id", "outcome"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            switch (name) {
                case MCP_TOOL_NAMES[0]:
                    return await this.handlers.handleSaveMemory(args);
                case MCP_TOOL_NAMES[1]:
                    return await this.handlers.handleRecall(args);
                case MCP_TOOL_NAMES[2]:
                    return await this.handlers.handleUpdateMemory(args);
                case MCP_TOOL_NAMES[3]:
                    return await this.handlers.handleListMemories(args);
                case MCP_TOOL_NAMES[4]:
                    return await this.handlers.handleReportOutcome(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('Starting Gemdex Memory MCP server...');
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // `gemdex serve` (or `gemdex-mcp serve`) starts the localhost HTTP sidecar
    // that backs the desktop manager app, instead of the stdio MCP server.
    if (args[0] === 'serve') {
        await runServe(args.slice(1));
        return;
    }

    const cliExitCode = await runCli(args);
    if (cliExitCode !== null) {
        process.exitCode = cliExitCode;
        return;
    }

    const config = createConfig();
    logConfigurationSummary(config);

    const server = new GemdexMemoryServer(config);
    await server.start();
}

process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});

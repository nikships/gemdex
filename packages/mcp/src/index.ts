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
import { MemoryBackend } from "gemdex-core";

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
`;

const UPDATE_MEMORY_DESCRIPTION = `
Revise an existing memory in place, identified by its id.

🎯 **When to use**: when the user asks to update/correct a stored memory
("the notarization step changed — update that memory"). Get the id from a prior
save_memory or recall result.

Behavior: re-chunks and re-embeds the new content under the same id. Omitted
fields are preserved — leave out \`content\` to keep the prior text, leave out
\`attachments\` to keep the prior media (pass \`attachments: []\` to clear it).
Each attachment is either a local file \`path\` (preferred) or inline base64
\`data\`. There is no delete via MCP — deletion is a human action in the desktop app.
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
        this.handlers = new MemoryToolHandlers(store);

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
                                description: "Replacement content. Omit to keep the existing text.",
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

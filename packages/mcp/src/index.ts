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
import { MemoryStore } from "gemdex-core";

import { createConfig, logConfigurationSummary, showHelpMessage, GemdexConfig } from "./config.js";
import { createMemoryStore } from "./memory.js";
import { MemoryToolHandlers } from "./handlers.js";
import { runServe } from "./serve.js";

const SAVE_MEMORY_DESCRIPTION = `
Persist a new memory to the user's global, durable memory layer.

🎯 **When to use**: ONLY when the user explicitly asks you to remember or save
something ("save this to memory", "remember that…", "store these credentials").
Never capture proactively.

Behavior: the content is chunked, embedded via Gemini, and stored globally
(searchable from every repo and session). Returns the new memory id.
`;

const RECALL_DESCRIPTION = `
Retrieve memories from the user's global memory layer by natural-language query.

🎯 **When to use**: ONLY when the user points you at memory ("check your memory
layer", "how do we usually do X", "what were those credentials"). Never recall
unprompted.

Behavior: hybrid semantic + BM25 search returns the FULL matching memories
(never fragments), ranked by relevance. Use the returned content directly.
`;

const UPDATE_MEMORY_DESCRIPTION = `
Revise an existing memory in place, identified by its id.

🎯 **When to use**: when the user asks to update/correct a stored memory
("the notarization step changed — update that memory"). Get the id from a prior
save_memory or recall result.

Behavior: re-chunks and re-embeds the new content under the same id.
There is no delete via MCP — deletion is a human action in the desktop app.
`;

class GemdexMemoryServer {
    private server: Server;
    private handlers: MemoryToolHandlers;

    constructor(config: GemdexConfig) {
        this.server = new Server(
            { name: config.name, version: config.version },
            { capabilities: { tools: {} } },
        );

        const store: MemoryStore = createMemoryStore(config);
        this.handlers = new MemoryToolHandlers(store);

        this.setupTools();
    }

    private setupTools() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "save_memory",
                    description: SAVE_MEMORY_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: {
                                type: "string",
                                description: "The memory content. A one-line fact or a long playbook — anything.",
                            },
                            title: {
                                type: "string",
                                description: "Optional human-readable name. Auto-derived from content if omitted.",
                            },
                        },
                        required: ["content"],
                    },
                },
                {
                    name: "recall",
                    description: RECALL_DESCRIPTION,
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Natural-language description of what to recall.",
                            },
                            limit: {
                                type: "number",
                                description: "Max number of memories to return.",
                                default: 10,
                                maximum: 50,
                            },
                        },
                        required: ["query"],
                    },
                },
                {
                    name: "update_memory",
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
                                description: "The full replacement content for the memory.",
                            },
                            title: {
                                type: "string",
                                description: "Optional new title. Auto-derived from content if omitted.",
                            },
                        },
                        required: ["id", "content"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            switch (name) {
                case "save_memory":
                    return await this.handlers.handleSaveMemory(args);
                case "recall":
                    return await this.handlers.handleRecall(args);
                case "update_memory":
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

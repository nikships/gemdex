import { useState } from "react";
import { CodeBlock } from "./CodeBlock";

type TabKey = "plugin" | "manual" | "other" | "lib";

const TABS: { key: TabKey; label: string }[] = [
    { key: "plugin", label: "Claude Code · plugin" },
    { key: "manual", label: "Claude Code · manual" },
    { key: "other", label: "Cursor / Codex / others" },
    { key: "lib", label: "As a library" },
];

export function Quickstart() {
    const [tab, setTab] = useState<TabKey>("plugin");

    return (
        <section
            id="quickstart"
            style={{ background: "var(--surface)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}
        >
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">Quickstart · under a minute</div>
                    <h2>Wire it into your agent.</h2>
                    <p>
                        There's no setup step for the store — LanceDB is embedded and persists at{" "}
                        <code className="k">~/.gemdex/lance</code> the first time you save. Pick your client:
                    </p>
                </div>
                <div className="qs reveal">
                    <div className="tabs" role="tablist" aria-label="Install method">
                        {TABS.map((t) => (
                            <button
                                key={t.key}
                                role="tab"
                                aria-selected={tab === t.key}
                                onClick={() => setTab(t.key)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className="tab-body">
                        {tab === "plugin" && (
                            <div className="tab-panel active">
                                <CodeBlock title="claude code" copyable>
                                    <span className="c-cmt"># one-command plugin install — recommended</span>
                                    {"\n"}
                                    <span className="c-fn">/plugin</span> marketplace add anand-92/gemdex{"\n"}
                                    <span className="c-fn">/plugin</span> install gemdex@gemdex
                                </CodeBlock>
                                <p className="note">
                                    You'll be prompted for <code>GEMINI_API_KEY</code> — stored in your OS keychain. The
                                    plugin ships the <code>gemdex</code> MCP server (runs via{" "}
                                    <code>npx -y gemdex-mcp@latest</code>, no local checkout) and a <code>memory</code>{" "}
                                    skill that nudges your agent to save / recall only when you explicitly point at
                                    memory.
                                </p>
                            </div>
                        )}
                        {tab === "manual" && (
                            <div className="tab-panel active">
                                <CodeBlock title="terminal" copyable>
                                    <span className="c-prompt">$</span> claude mcp add gemdex \{"\n"}
                                    {"    "}
                                    <span className="c-key">-e</span> GEMINI_API_KEY=your-key \{"\n"}
                                    {"    "}-- npx -y gemdex-mcp@latest
                                </CodeBlock>
                                <p className="note">
                                    No plugin, no marketplace — just registers the MCP server directly with Claude Code.
                                </p>
                            </div>
                        )}
                        {tab === "other" && (
                            <div className="tab-panel active">
                                <CodeBlock title="mcp config · json" copyable>
                                    {"{\n  "}
                                    <span className="c-key">"mcpServers"</span>
                                    {": {\n    "}
                                    <span className="c-key">"gemdex"</span>
                                    {": {\n      "}
                                    <span className="c-key">"command"</span>
                                    {": "}
                                    <span className="c-str">"npx"</span>
                                    {",\n      "}
                                    <span className="c-key">"args"</span>
                                    {": ["}
                                    <span className="c-str">"-y"</span>
                                    {", "}
                                    <span className="c-str">"gemdex-mcp@latest"</span>
                                    {"],\n      "}
                                    <span className="c-key">"env"</span>
                                    {": { "}
                                    <span className="c-key">"GEMINI_API_KEY"</span>
                                    {": "}
                                    <span className="c-str">"your-key"</span>
                                    {" }\n    }\n  }\n}"}
                                </CodeBlock>
                                <p className="note">
                                    Works in any MCP client — Cursor, Codex CLI, Windsurf, Cline, Continue, Zed. Paste the
                                    memory-layer nudge into your client's root instructions file (conventionally{" "}
                                    <code>AGENTS.md</code>) so the agent actually reaches for it.
                                </p>
                            </div>
                        )}
                        {tab === "lib" && (
                            <div className="tab-panel active">
                                <CodeBlock title="memory.ts" copyable>
                                    <span className="c-key">import</span>
                                    {" { MemoryStore, LanceDBVectorDatabase, GeminiEmbedding } "}
                                    <span className="c-key">from</span> <span className="c-str">'gemdex-core'</span>;{"\n\n"}
                                    <span className="c-key">const</span> embedding = <span className="c-key">new</span>{" "}
                                    <span className="c-fn">GeminiEmbedding</span>
                                    {"({\n  apiKey: process.env.GEMINI_API_KEY!,\n  model: "}
                                    <span className="c-str">'gemini-embedding-2'</span>
                                    {",\n});\n"}
                                    <span className="c-key">const</span> memory = <span className="c-key">new</span>{" "}
                                    <span className="c-fn">MemoryStore</span>
                                    {"({ embedding, vectorDatabase: "}
                                    <span className="c-key">new</span> <span className="c-fn">LanceDBVectorDatabase</span>
                                    {"() });\n\n"}
                                    <span className="c-key">const</span> {"{ id } = "}
                                    <span className="c-key">await</span> memory.<span className="c-fn">save</span>
                                    {"({ content: "}
                                    <span className="c-str">'Notarize with: xcrun notarytool submit …'</span>
                                    {" });\n"}
                                    <span className="c-key">const</span> hits = <span className="c-key">await</span>{" "}
                                    memory.<span className="c-fn">recall</span>(
                                    <span className="c-str">'how do we notarize builds'</span>
                                    {", 5);\nconsole."}
                                    <span className="c-fn">log</span>
                                    {"(hits[0].content); "}
                                    <span className="c-cmt">// the full memory, never a fragment</span>
                                </CodeBlock>
                                <p className="note">
                                    Skip the MCP server entirely and embed the store in your own TypeScript. Pass nothing
                                    to the DB to use the default <code>~/.gemdex/lance</code> directory.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}

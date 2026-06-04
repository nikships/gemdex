export function DesktopApp() {
    return (
        <section
            id="app"
            style={{ background: "var(--surface)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}
        >
            <div className="wrap split rev">
                <div className="txt reveal">
                    <div className="kicker">The desktop app</div>
                    <h3>
                        A native, <em>manage-only</em> window into your memory.
                    </h3>
                    <p>
                        Built on zero-native, it opens straight into your memory layer — <b>browse, create, edit and
                        delete</b> memories, including inline media you can drag-and-drop, caption and preview in place.
                    </p>
                    <p>
                        There's <b>no free-text search box</b> — recall is an agent/MCP capability. The only recall it
                        surfaces is &ldquo;Find similar&rdquo;: recall-by-example from an existing attachment. On launch
                        it spawns its own local sidecar; you never run a command.
                    </p>
                    <div className="chips">
                        <span className="chip">
                            <b>browse</b> &amp; edit
                        </span>
                        <span className="chip">
                            <b>attachments</b> inline
                        </span>
                        <span className="chip">
                            <b>export / import</b> JSONL
                        </span>
                        <span className="chip">
                            <b>127.0.0.1</b> only
                        </span>
                    </div>
                </div>
                <div className="reveal">
                    <div className="browser">
                        <div className="bb">
                            <span className="d" />
                            <span className="d" />
                            <span className="d" />
                            <span className="ad">gemdex — memory manager</span>
                        </div>
                        <img
                            className="shot"
                            src="./brand/app-screenshot-manager.png"
                            width={1024}
                            height={791}
                            alt="The gemdex desktop app: a sidebar list of saved memories beside a detail pane showing a memory's title, content and an inline attachment."
                            loading="lazy"
                        />
                    </div>
                </div>
            </div>
        </section>
    );
}

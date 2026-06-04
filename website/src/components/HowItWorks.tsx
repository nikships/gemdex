export function HowItWorks() {
    return (
        <section
            id="how"
            style={{ background: "var(--surface)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}
        >
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">How it works</div>
                    <h2>
                        The <em>parent-document</em> retriever, in three moves.
                    </h2>
                    <p>Sharp matching on long content — but the agent always gets the whole memory back, in one shot.</p>
                </div>
                <div className="pipe">
                    <div className="pipe-steps">
                        <div className="pstep reveal">
                            <span className="pn">1</span>
                            <div>
                                <h4>Save</h4>
                                <p>
                                    <code>content</code> is split into retrieval chunks; each chunk is embedded with
                                    Gemini and stored with a <code>parent_id</code> pointing back to the whole memory.
                                </p>
                            </div>
                        </div>
                        <div className="pstep reveal">
                            <span className="pn">2</span>
                            <div>
                                <h4>Recall</h4>
                                <p>
                                    Hybrid search (dense vector + BM25, fused with Reciprocal Rank Fusion) ranks chunks,
                                    then each match resolves to its full parent memory, deduped by <code>parent_id</code>.
                                </p>
                            </div>
                        </div>
                        <div className="pstep reveal">
                            <span className="pn">3</span>
                            <div>
                                <h4>Store</h4>
                                <p>
                                    Everything lives in one global LanceDB table under <code>~/.gemdex</code>. The agent's
                                    MCP process and the desktop app share the same store.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flow-diagram reveal">
                        <svg viewBox="0 0 360 300" role="img" aria-label="gemdex pipeline diagram">
                            <defs>
                                <marker id="ar" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
                                    <path d="M0 0l6 3-6 3z" fill="var(--faint)" />
                                </marker>
                            </defs>
                            <g fontFamily="var(--mono)" fontSize="12">
                                {/* save memory */}
                                <rect x="110" y="14" width="140" height="40" rx="9" fill="var(--panel-soft)" stroke="var(--border-strong)" />
                                <text x="180" y="33" textAnchor="middle" fill="var(--fg)" fontWeight="600">
                                    save_memory
                                </text>
                                <text x="180" y="47" textAnchor="middle" fill="var(--muted)" fontSize="10">
                                    content + attachments
                                </text>
                                <line x1="180" y1="54" x2="180" y2="78" stroke="var(--faint)" strokeWidth="1.5" markerEnd="url(#ar)" />
                                {/* chunker */}
                                <rect x="118" y="80" width="124" height="34" rx="9" fill="color-mix(in srgb,var(--rust) 12%,transparent)" stroke="color-mix(in srgb,var(--rust) 32%,transparent)" />
                                <text x="180" y="101" textAnchor="middle" fill="var(--rust)" fontWeight="600">
                                    chunker
                                </text>
                                <line x1="180" y1="114" x2="180" y2="136" stroke="var(--faint)" strokeWidth="1.5" markerEnd="url(#ar)" />
                                {/* gemini embed */}
                                <rect x="104" y="138" width="152" height="34" rx="9" fill="color-mix(in srgb,var(--gold) 16%,transparent)" stroke="color-mix(in srgb,var(--gold) 38%,transparent)" />
                                <text x="180" y="159" textAnchor="middle" fill="#9a7322" fontWeight="600">
                                    Gemini embed
                                </text>
                                <line x1="180" y1="172" x2="180" y2="194" stroke="var(--faint)" strokeWidth="1.5" markerEnd="url(#ar)" />
                                {/* lancedb */}
                                <rect x="96" y="196" width="168" height="46" rx="9" fill="color-mix(in srgb,var(--sage) 16%,transparent)" stroke="color-mix(in srgb,var(--sage) 38%,transparent)" />
                                <text x="180" y="216" textAnchor="middle" fill="var(--sage-deep)" fontWeight="600">
                                    LanceDB · ~/.gemdex
                                </text>
                                <text x="180" y="231" textAnchor="middle" fill="var(--muted)" fontSize="10">
                                    chunks ↔ parent_id
                                </text>
                                {/* recall loop */}
                                <path d="M96 219 H40 V104 a8 8 0 0 1 8-8 H110" fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeDasharray="4 4" markerEnd="url(#ar)" />
                                <text x="34" y="160" textAnchor="middle" fill="var(--rust)" fontSize="11" fontWeight="600" transform="rotate(-90 34 160)">
                                    recall → full memory
                                </text>
                                <rect x="270" y="196" width="78" height="46" rx="9" fill="var(--panel-soft)" stroke="var(--border-strong)" />
                                <text x="309" y="216" textAnchor="middle" fill="var(--fg)" fontWeight="600" fontSize="11">
                                    RRF
                                </text>
                                <text x="309" y="231" textAnchor="middle" fill="var(--muted)" fontSize="9">
                                    dense+BM25
                                </text>
                                <line x1="270" y1="219" x2="266" y2="219" stroke="var(--faint)" strokeWidth="1.5" />
                            </g>
                        </svg>
                    </div>
                </div>
            </div>
        </section>
    );
}

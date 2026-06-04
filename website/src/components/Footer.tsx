import { BrandMark } from "./BrandMark";

export function Footer() {
    return (
        <footer>
            <div className="wrap">
                <div className="foot">
                    <div>
                        <a className="brand" href="#top">
                            <BrandMark />
                            gemdex
                        </a>
                        <p className="tag">
                            A global, persistent memory layer for AI coding agents. Remember once, recall everywhere.
                        </p>
                    </div>
                    <div className="foot-links">
                        <div className="foot-col">
                            <h6>Project</h6>
                            <a href="https://github.com/anand-92/gemdex" target="_blank" rel="noopener">
                                GitHub
                            </a>
                            <a href="https://www.npmjs.com/package/gemdex-mcp" target="_blank" rel="noopener">
                                npm · gemdex-mcp
                            </a>
                            <a href="https://github.com/anand-92/gemdex/discussions" target="_blank" rel="noopener">
                                Discussions
                            </a>
                            <a href="https://github.com/anand-92/gemdex/issues" target="_blank" rel="noopener">
                                Issues
                            </a>
                        </div>
                        <div className="foot-col">
                            <h6>Learn</h6>
                            <a href="#why">Why gemdex</a>
                            <a href="#how">How it works</a>
                            <a href="#tools">The 3 tools</a>
                            <a href="#quickstart">Quickstart</a>
                        </div>
                        <div className="foot-col">
                            <h6>Built with</h6>
                            <a href="https://ai.google.dev/" target="_blank" rel="noopener">
                                Gemini embeddings
                            </a>
                            <a href="https://lancedb.com/" target="_blank" rel="noopener">
                                LanceDB
                            </a>
                            <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">
                                Model Context Protocol
                            </a>
                        </div>
                    </div>
                </div>
                <div className="foot-base">
                    <span>MIT licensed · no telemetry · your memories never leave your disk.</span>
                    <span className="mono">npx gemdex serve</span>
                </div>
            </div>
        </footer>
    );
}

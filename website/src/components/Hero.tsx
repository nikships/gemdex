import { useToast } from "../context/ToastContext";
import { CopyIcon, StarIcon } from "./icons";

const INSTALL_CMD = "claude mcp add gemdex -e GEMINI_API_KEY=your-key -- npx -y gemdex-mcp@latest";

export function Hero() {
    const { copy } = useToast();

    return (
        <section className="hero">
            <div className="wrap hero-grid">
                <div className="reveal">
                    <span className="eyebrow">
                        <span className="dot" />
                        Gemini embeddings · LanceDB · MCP
                    </span>
                    <h1 className="hero-h">
                        Remember once,
                        <br />
                        <em>recall everywhere.</em>
                    </h1>
                    <p className="hero-sub">
                        gemdex is a <b>global, persistent memory layer</b> for AI coding agents. You teach your agent
                        something once — it remembers forever, across every repo, every session, every machine.
                    </p>
                    <div className="hero-cta">
                        <button className="btn btn-primary" onClick={() => copy(INSTALL_CMD, "Install command copied")}>
                            <CopyIcon />
                            Copy install
                        </button>
                        <a className="btn btn-ghost" href="#quickstart">
                            Read the quickstart
                        </a>
                        <span className="stars-pill">
                            <StarIcon />
                            MIT · no telemetry · runs local
                        </span>
                    </div>
                </div>

                <div className="device-stage reveal">
                    <img
                        className="device-art"
                        src="./brand/hero-device.png"
                        width={420}
                        height={394}
                        alt="A cozy retro handheld console whose glowing screen shows a gold neural-network brain with a bookmark — gemdex's memory layer."
                    />
                    <span className="float-note fn1" aria-hidden="true" />
                    <span className="float-note fn2" aria-hidden="true" />
                    <span className="float-note fn3" aria-hidden="true" />
                </div>
            </div>
        </section>
    );
}

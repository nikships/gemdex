import {
    BrainIcon,
    DesktopIcon,
    GlobeIcon,
    LocalIcon,
    PlugIcon,
    SearchIcon,
} from "./icons";
import type { ReactNode } from "react";

interface Feature {
    icon: ReactNode;
    title: string;
    body: ReactNode;
}

const FEATURES: Feature[] = [
    {
        icon: <BrainIcon />,
        title: "You decide what to remember",
        body: (
            <>
                Explicit <code>save_memory</code> / <code>recall</code> / <code>update_memory</code>. No silent capture,
                no background recall — it only acts when you point at it.
            </>
        ),
    },
    {
        icon: <GlobeIcon />,
        title: "One global pool",
        body: "Every memory is searchable from everywhere. No scopes, no folders, no tags — embeddings do the disambiguation for you.",
    },
    {
        icon: <SearchIcon />,
        title: "Sharp recall, whole answers",
        body: (
            <>
                Hybrid semantic + BM25 over internal chunks — but recall always returns the{" "}
                <b>full memory, never a fragment.</b>
            </>
        ),
    },
    {
        icon: <PlugIcon />,
        title: "Plug-and-play",
        body: "Speaks MCP over stdio, so Claude Code, Cursor, Codex CLI, Windsurf, Cline, Continue, Zed and friends work instantly.",
    },
    {
        icon: <LocalIcon />,
        title: "Truly local",
        body: (
            <>
                Memories live in a single directory on your disk — LanceDB at <code>~/.gemdex</code>. No Docker, no
                daemon, no SaaS, no telemetry.
            </>
        ),
    },
    {
        icon: <DesktopIcon />,
        title: "Desktop manager",
        body: "A native app to browse, edit, delete, export and import your memory layer — including inline image, audio, video and PDF attachments.",
    },
];

export function Features() {
    return (
        <section>
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">Why gemdex</div>
                    <h2>
                        Memory you control — <em>not</em> a black box.
                    </h2>
                    <p>No silent capture, no background recall, no SaaS. Six things make it different.</p>
                </div>
                <div className="f-grid">
                    {FEATURES.map((f) => (
                        <div className="card reveal" key={f.title}>
                            <div className="ic">{f.icon}</div>
                            <h3>{f.title}</h3>
                            <p>{f.body}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

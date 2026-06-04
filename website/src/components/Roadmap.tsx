import type { ReactNode } from "react";
import { CheckIcon } from "./icons";

const ITEMS: ReactNode[] = [
    "Optional encryption-at-rest for sensitive memories",
    "Packaged desktop binaries — macOS / Linux / Windows",
    "Multi-machine sync service (beyond export / import)",
    "Memory linking / references",
    <>
        A CLI — <code className="k">gemdex recall "…"</code> for non-MCP workflows
    </>,
];

export function Roadmap() {
    return (
        <section style={{ paddingTop: 24 }}>
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">Roadmap</div>
                    <h2>
                        What's <em>coming.</em>
                    </h2>
                </div>
                <div className="road">
                    {ITEMS.map((item, i) => (
                        <div className="ri reveal" key={i}>
                            <span className="box" />
                            {item}
                        </div>
                    ))}
                    <div className="ri reveal">
                        <span className="box">
                            <CheckIcon />
                        </span>
                        Open a discussion with your idea
                    </div>
                </div>
            </div>
        </section>
    );
}

import type { ReactNode } from "react";
import { PencilIcon, SaveIcon, SearchIcon } from "./icons";

interface Tool {
    icon: ReactNode;
    name: string;
    lede: string;
    input: ReactNode;
    returns: ReactNode;
    when: ReactNode;
}

const TOOLS: Tool[] = [
    {
        icon: <SaveIcon />,
        name: "save_memory",
        lede: "Writes a new memory. Only when you tell it to remember or save.",
        input: (
            <>
                <code>content</code> and/or <code>attachments</code>, optional <code>title</code>
            </>
        ),
        returns: (
            <>
                new <code>id</code> + resolved title
            </>
        ),
        when: <>you say remember / save.</>,
    },
    {
        icon: <SearchIcon />,
        name: "recall",
        lede: "Searches the global pool. Only when you point at memory.",
        input: (
            <>
                <code>query</code> and/or <code>attachments</code>, optional <code>limit</code> (~10)
            </>
        ),
        returns: "full memories ranked by relevance",
        when: <>&ldquo;check your memory layer&rdquo;.</>,
    },
    {
        icon: <PencilIcon />,
        name: "update_memory",
        lede: "Revises a stored memory in place by id.",
        input: (
            <>
                <code>id</code> required; <code>content</code> / <code>title</code> / <code>attachments</code>
            </>
        ),
        returns: (
            <>
                updated <code>id</code> + title
            </>
        ),
        when: <>you revise a memory.</>,
    },
];

export function Tools() {
    return (
        <section id="tools">
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">The MCP surface</div>
                    <h2>
                        Three tools. <em>That's the whole API.</em>
                    </h2>
                    <p>
                        Deletion is intentionally <b>not</b> an agent tool — it's a deliberate human action in the desktop
                        app.
                    </p>
                </div>
                <div className="tools">
                    {TOOLS.map((t) => (
                        <div className="tool reveal" key={t.name}>
                            <div className="top">
                                <div className="nm">
                                    {t.icon}
                                    {t.name}
                                </div>
                                <p className="lede">{t.lede}</p>
                            </div>
                            <div className="rows">
                                <div className="r">
                                    <span className="lbl">Input</span>
                                    <span className="val">{t.input}</span>
                                </div>
                                <div className="r">
                                    <span className="lbl">Returns</span>
                                    <span className="val">{t.returns}</span>
                                </div>
                            </div>
                            <div className="when">
                                <b>Calls when</b> — {t.when}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

import { CodeBlock } from "./CodeBlock";

export function Multimodal() {
    return (
        <section>
            <div className="wrap split">
                <div className="txt reveal">
                    <div className="kicker">Multimodal</div>
                    <h3>
                        Recall a memory from a <em>screenshot.</em>
                    </h3>
                    <p>
                        <code className="k">save_memory</code> and <code className="k">update_memory</code> take inline
                        media — images, audio, video, PDF — embedded into the <b>same space</b> as text by{" "}
                        <code className="k">gemini-embedding-2</code>.
                    </p>
                    <p>
                        Query by text, by media, or both. Each attachment runs its own similarity branch, fused with the
                        text branch via Reciprocal Rank Fusion — so a screenshot finds a memory as easily as a phrase
                        does.
                    </p>
                    <div className="chips">
                        <span className="chip">
                            <b>PNG / JPEG</b> ≤ 6
                        </span>
                        <span className="chip">
                            <b>MP3 / WAV</b> ≤ 1
                        </span>
                        <span className="chip">
                            <b>MP4 / MOV</b> ≤ 1
                        </span>
                        <span className="chip">
                            <b>PDF</b> ≤ 1
                        </span>
                    </div>
                </div>
                <div className="reveal">
                    <div className="mm-art">
                        <img
                            src="./brand/multimodal-spot.png"
                            width={460}
                            height={345}
                            alt="A glowing memory orb floats above an open hand as a photo dissolves into gold constellation lines, absorbed into the memory."
                        />
                    </div>
                    <div style={{ marginTop: 18 }}>
                        <CodeBlock title="recall by image">
                            <span className="c-cmt">// embed a screenshot into the shared space</span>
                            {"\n"}
                            <span className="c-key">await</span> memory.<span className="c-fn">recall</span>
                            {"({\n  attachments: [{\n    mimeType: "}
                            <span className="c-str">'image/png'</span>
                            {",\n    data: screenshotBase64,\n    caption: "}
                            <span className="c-str">'the deploy dashboard'</span>
                            {",\n  }],\n});\n"}
                            <span className="c-cmt">{"// → returns the full memory you saved\n//   alongside that screenshot, weeks ago."}</span>
                        </CodeBlock>
                    </div>
                </div>
            </div>
        </section>
    );
}

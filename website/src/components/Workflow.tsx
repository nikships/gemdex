import { CodeBlock } from "./CodeBlock";

export function Workflow() {
    return (
        <section style={{ paddingTop: 24 }}>
            <div className="wrap">
                <div className="sec-head reveal">
                    <div className="kicker">The motivating loop</div>
                    <h2>
                        Write it down once. <em>Pick it up anywhere.</em>
                    </h2>
                    <p>
                        The same memory, saved in one session, recalled in a different repo on a different machine in a
                        different client.
                    </p>
                </div>
                <div className="flow">
                    <div className="step reveal">
                        <div className="tag">
                            <span className="n">1</span>DURING A SESSION
                        </div>
                        <CodeBlock title="claude code · repo-a">
                            {"“We just figured out how to\nwire up the Junie review\nworkflow — "}
                            <span className="c-key">save that to memory.</span>
                            {"”"}
                        </CodeBlock>
                    </div>
                    <div className="step reveal">
                        <div className="tag">
                            <span className="n">2</span>WEEKS LATER · ANOTHER REPO
                        </div>
                        <CodeBlock title="cursor · repo-b">
                            {"“Set up the Junie review\nworkflow here — "}
                            <span className="c-key">check your{"\n"}memory layer</span>
                            {" for how we do it.”"}
                        </CodeBlock>
                    </div>
                    <div className="step reveal">
                        <div className="tag">
                            <span className="n">3</span>DIFFERENT MACHINE &amp; APP
                        </div>
                        <CodeBlock title="codex cli · laptop-2">
                            {"“Notarize and sign this build —\nthe credentials and steps are\n"}
                            <span className="c-key">in my memory layer.</span>
                            {"”"}
                        </CodeBlock>
                    </div>
                </div>
            </div>
        </section>
    );
}

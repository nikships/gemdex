import { ShieldIcon } from "./icons";

export function Privacy() {
    return (
        <section>
            <div className="wrap">
                <div className="notice reveal">
                    <div className="ic">
                        <ShieldIcon />
                    </div>
                    <div>
                        <h3>A power-dev tool with zero guardrails — by design.</h3>
                        <p>
                            You may store API keys, credentials and account details in plaintext, locally. There's{" "}
                            <b>no secret redaction, no encryption mandate, no safety enforcement.</b> Storing sensitive
                            data is your informed choice. Nothing leaves your machine except the text you embed, which is
                            sent to the Gemini embeddings API.
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
}

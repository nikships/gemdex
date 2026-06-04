import { GithubIcon } from "./icons";

export function FinalCta() {
    return (
        <section>
            <div className="wrap">
                <div className="final reveal">
                    <img
                        className="star-art"
                        src="./brand/star.png"
                        width={96}
                        height={96}
                        alt=""
                        aria-hidden="true"
                    />
                    <h2 className="serif">
                        If gemdex makes your agent <em>remember</em> —
                    </h2>
                    <p>give it a star. It's the single biggest thing that helps the project grow.</p>
                    <div className="hero-cta">
                        <a className="btn btn-primary" href="https://github.com/anand-92/gemdex" target="_blank" rel="noopener">
                            <GithubIcon />
                            Star on GitHub
                        </a>
                        <a className="btn btn-ghost" href="https://www.npmjs.com/package/gemdex-mcp" target="_blank" rel="noopener">
                            View on npm
                        </a>
                    </div>
                </div>
            </div>
        </section>
    );
}

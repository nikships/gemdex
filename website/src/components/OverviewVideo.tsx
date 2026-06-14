export function OverviewVideo() {
    return (
        <section id="overview-video" className="video-section">
            <div className="wrap">
                <div className="video-card reveal">
                    <div className="video-copy">
                        <div className="kicker">Watch the system</div>
                        <h2>
                            A quick tour of <em>global memory</em>.
                        </h2>
                        <p>
                            See how Gemdex connects agents, repos, local storage, parent-document recall, and the desktop
                            manager into one memory layer you control.
                        </p>
                    </div>
                    <div className="video-frame" aria-label="Gemdex overview video">
                        <video
                            controls
                            playsInline
                            poster="./brand/gemdex-hyperframes-poster.jpg"
                            preload="metadata"
                        >
                            <source src="./brand/gemdex-hyperframes.mp4" type="video/mp4" />
                            <track
                                kind="captions"
                                src="./brand/gemdex-hyperframes.vtt"
                                srcLang="en"
                                label="English"
                                default
                            />
                            <a href="./brand/gemdex-hyperframes.mp4">Download the Gemdex overview video.</a>
                        </video>
                    </div>
                </div>
            </div>
        </section>
    );
}

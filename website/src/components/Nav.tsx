import { useScrolled } from "../hooks/useScrolled";
import { useTheme } from "../hooks/useTheme";
import { BrandMark } from "./BrandMark";
import { GithubIcon, MoonIcon, SunIcon } from "./icons";

const NAV_LINKS = [
    { href: "#why", label: "Why" },
    { href: "#how", label: "How it works" },
    { href: "#tools", label: "Tools" },
    { href: "#quickstart", label: "Quickstart" },
    { href: "#app", label: "Desktop app" },
];

export function Nav() {
    const scrolled = useScrolled();
    const { theme, toggle } = useTheme();
    const dark = theme === "dark";

    return (
        <header className={`nav${scrolled ? " scrolled" : ""}`} id="nav">
            <div className="nav-in">
                <a className="brand" href="#top" aria-label="gemdex home">
                    <BrandMark />
                    gemdex
                </a>
                <nav className="nav-links">
                    {NAV_LINKS.map((l) => (
                        <a key={l.href} href={l.href}>
                            {l.label}
                        </a>
                    ))}
                </nav>
                <div className="nav-right">
                    <button
                        className="icon-btn"
                        id="theme-toggle"
                        onClick={toggle}
                        aria-label="Toggle dark mode"
                        title="Toggle theme"
                    >
                        {dark ? <MoonIcon /> : <SunIcon />}
                    </button>
                    <a className="btn btn-primary" href="https://github.com/anand-92/gemdex" target="_blank" rel="noopener">
                        <GithubIcon />
                        Star
                    </a>
                </div>
            </div>
        </header>
    );
}

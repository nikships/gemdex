import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark";

function readInitialTheme(): Theme {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "dark" || current === "light") return current;
    try {
        const saved = localStorage.getItem("gemdex-theme");
        if (saved === "dark" || saved === "light") return saved;
    } catch {
        /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme:dark)").matches ? "dark" : "light";
}

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(readInitialTheme);

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        try {
            localStorage.setItem("gemdex-theme", theme);
        } catch {
            /* ignore */
        }
    }, [theme]);

    const toggle = useCallback(() => {
        setTheme((t) => (t === "dark" ? "light" : "dark"));
    }, []);

    return { theme, toggle };
}

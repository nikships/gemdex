import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ToastApi {
    /** Copy text to clipboard, then show a toast (defaults to "Copied to clipboard"). */
    copy: (text: string, message?: string) => Promise<void>;
    show: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

async function copyText(txt: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(txt);
            return;
        } catch {
            /* fall through to legacy path */
        }
    }
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand("copy");
    } catch {
        /* ignore */
    }
    document.body.removeChild(ta);
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [message, setMessage] = useState("Copied to clipboard");
    const [visible, setVisible] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    const show = useCallback((msg: string) => {
        setMessage(msg || "Copied to clipboard");
        setVisible(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setVisible(false), 1700);
    }, []);

    const copy = useCallback(
        async (text: string, msg?: string) => {
            await copyText(text);
            show(msg ?? "Copied to clipboard");
        },
        [show],
    );

    useEffect(() => () => window.clearTimeout(timer.current), []);

    return (
        <ToastContext.Provider value={{ copy, show }}>
            {children}
            <div className={`copied${visible ? " show" : ""}`} role="status" aria-live="polite">
                {message}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastApi {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used within a ToastProvider");
    return ctx;
}

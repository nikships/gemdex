import { useRef, type ReactNode } from "react";
import { useToast } from "../context/ToastContext";

interface CodeBlockProps {
    title: string;
    /** Show the "Copy" button in the title bar (copies the <pre> text). */
    copyable?: boolean;
    children: ReactNode;
}

export function CodeBlock({ title, copyable = false, children }: CodeBlockProps) {
    const preRef = useRef<HTMLPreElement>(null);
    const { copy } = useToast();

    const onCopy = () => {
        const text = preRef.current?.innerText ?? "";
        // strip leading shell prompts ("$ ") like the original export
        void copy(text.replace(/^\$\s/gm, ""));
    };

    return (
        <div className="code">
            <div className="code-bar">
                <span className="dt" />
                <span className="dt" />
                <span className="dt" />
                <span className="ttl">{title}</span>
                {copyable && (
                    <button className="copy" type="button" onClick={onCopy}>
                        Copy
                    </button>
                )}
            </div>
            <pre ref={preRef}>{children}</pre>
        </div>
    );
}

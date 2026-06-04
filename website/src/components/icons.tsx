import type { SVGProps } from "react";

/* Hand-drawn-feel line icons (gold/ink), per the brand spec — never emoji.
   Each forwards props so callers can set aria-hidden, class, etc. */

type Icon = (props: SVGProps<SVGSVGElement>) => JSX.Element;

const stroke = {
    fill: "none",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
};

export const SunIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...p}>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
);

export const MoonIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
);

export const GithubIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
        <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.3-1.8-1.3-1.8-1.1-.7 0-.7 0-.7 1.2 0 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 5 18.3 5.3 18.3 5.3c.7 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
    </svg>
);

export const CopyIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);

export const StarIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
        <path d="m12 2 2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z" />
    </svg>
);

/* feature card icons */
export const BrainIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V16a3 3 0 0 0 6 0M12 5a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8M12 5V3" />
    </svg>
);

export const GlobeIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
    </svg>
);

export const SearchIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
    </svg>
);

export const PlugIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M14 7l3-3a3 3 0 0 1 4 4l-3 3M10 17l-3 3a3 3 0 0 1-4-4l3-3M8 16l8-8" />
    </svg>
);

export const LocalIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
        <path d="M9 9h6v6H9z" />
    </svg>
);

export const DesktopIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
    </svg>
);

/* tool icons */
export const SaveIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
);

export const PencilIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
);

export const ShieldIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6z" />
        <path d="M12 8v4M12 16h.01" />
    </svg>
);

export const CheckIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" {...p}>
        <path d="M20 6 9 17l-5-5" />
    </svg>
);

export const ImageIcon: Icon = (p) => (
    <svg viewBox="0 0 24 24" stroke="currentColor" {...stroke} {...p}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-5-5L5 21" />
    </svg>
);

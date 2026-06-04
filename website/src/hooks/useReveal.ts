import { useEffect } from "react";

/**
 * Scroll-reveal: observes every `.reveal` element and adds `.in` when it
 * enters the viewport, with a small staggered transition delay (matching the
 * original export). Falls back to immediately revealing all if IO is missing.
 */
export function useReveal() {
    useEffect(() => {
        const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
        if (!("IntersectionObserver" in window)) {
            els.forEach((el) => el.classList.add("in"));
            return;
        }
        const io = new IntersectionObserver(
            (entries) => {
                entries.forEach((e) => {
                    if (e.isIntersecting) {
                        e.target.classList.add("in");
                        io.unobserve(e.target);
                    }
                });
            },
            { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
        );
        els.forEach((el, i) => {
            el.style.transitionDelay = `${Math.min(i % 3, 2) * 70}ms`;
            io.observe(el);
        });
        return () => io.disconnect();
    }, []);
}

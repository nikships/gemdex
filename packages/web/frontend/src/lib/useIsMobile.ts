import { useEffect, useState } from 'react';

export const MOBILE_BREAKPOINT = 1024; // Below 1024px is mobile / compact mode

export function checkIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  if (typeof window === 'undefined') return false;
  const isNarrow = window.innerWidth < breakpoint;
  const isMobileUA =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return isNarrow || (isMobileUA && hasTouch && window.innerWidth < 1200);
}

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => checkIsMobile(breakpoint));

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => {
      setIsMobile(checkIsMobile(breakpoint));
    };

    mql.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      mql.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [breakpoint]);

  return isMobile;
}

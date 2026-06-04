# gemdex website

The marketing landing page for gemdex — a **standalone** Vite + React + TypeScript
app. It is intentionally **outside the pnpm workspace** (the workspace only globs
`packages/*` and `examples/*`), so it has its own `package.json` / `node_modules`
and never affects `pnpm build` / `lint` / `typecheck` at the repo root.

## Develop

```bash
cd website
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve the production build
```

## Structure

- `src/components/` — one component per landing section (Hero, Features, Tools, …).
- `src/hooks/` — `useTheme` (light/dark + localStorage), `useScrolled` (nav
  hairline), `useReveal` (scroll-reveal IntersectionObserver).
- `src/context/ToastContext.tsx` — copy-to-clipboard + toast.
- `src/index.css` — design tokens + styles, ported from the design export and the
  desktop app's `styles.css` (same warm paper / rust / sage / gold palette).
- `public/brand/` — brand art. Real repo assets (`logo-mark-256.png`,
  `app-screenshot-manager.png`, `og.jpg`) plus hand-matched watercolor pieces
  (`hero-device.png`, `multimodal-spot.png`, `star.png`, `sprig.png`).

Light/dark themes follow `prefers-color-scheme` on first visit and persist the
user's choice under `localStorage["gemdex-theme"]`. An inline script in
`index.html` sets `data-theme` before first paint to avoid a flash.

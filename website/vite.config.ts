import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone marketing site. Base is "./" so the built bundle can be served
// from any sub-path (e.g. GitHub Pages project sites) without rewrites.
export default defineConfig({
    plugins: [react()],
    base: "./",
});

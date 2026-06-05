import { defineConfig } from "vite";

const productionCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: http://127.0.0.1:*",
  "media-src 'self' blob: http://127.0.0.1:*",
  "frame-src 'self' blob: http://127.0.0.1:*",
  "object-src 'none'",
  "connect-src 'self' http://127.0.0.1:*",
].join("; ");

const devCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "media-src 'self' blob: http://127.0.0.1:* http://localhost:*",
  "frame-src 'self' blob: http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
].join("; ");

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: "gemdex-csp",
      transformIndexHtml(html) {
        const csp = command === "serve" ? devCsp : productionCsp;
        return html.replace("%GEMDEX_CSP%", csp);
      },
    },
  ],
}));

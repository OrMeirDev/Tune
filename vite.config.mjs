import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built page may only run its own code: scripts, styles, images, sound and fonts from the app
// itself, nothing from the network, no plugins, no forms. Added to the build only (the dev server
// needs its live-reload connection and inline helpers).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');
const contentSecurityPolicy = {
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  plugins: [react(), contentSecurityPolicy],
  base: './',
  server: { port: 5175, strictPort: true },
});

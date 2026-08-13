import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// A real build identity, stamped into the HTML at build time. It used to be
// `new Date()` evaluated in the browser — the current date, identical for every
// build made on the same day, and therefore useless for telling a fresh dashboard
// from a stale cached one. freshness.js compares the value baked into the running
// page against the one in the document the rig is actually serving, so it has to
// be in the markup, not written in by script after load.
const BUILD_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

export default defineConfig({
  plugins: [
    {
      name: 'strikesense-build-stamp',
      transformIndexHtml(html) {
        return html
          .replace(/(name="ss-build" content=")[^"]*(")/, `$1${BUILD_ID}$2`)
          .replace(/(id="buildStamp"[^>]*>)[^<]*(<)/, `$1${BUILD_ID}$2`);
      },
    },
    viteSingleFile(),
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    target: 'esnext',
  },
});

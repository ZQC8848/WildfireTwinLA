import { fileURLToPath } from 'node:url';
export default {
  cacheDir: '/tmp/wildfire-norte-vite-cache',
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    'three': fileURLToPath(new URL('../web/node_modules/three', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5178, strictPort: true, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
};

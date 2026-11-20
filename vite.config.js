import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relatívna base -> funguje na GitHub Pages (/repo/) aj na Synology (ľubovoľný podpriečinok).
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'libheif-js'] },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Photo Sorter',
        short_name: 'Photo Sorter',
        description: 'Roztriedi fotky z priečinka lokálne v prehliadači – nič sa neuploaduje.',
        lang: 'sk',
        theme_color: '#141414',
        background_color: '#141414',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,wasm,webmanifest}'],
        // ORT WASM používame z /ort (kópia z node_modules); kópia, ktorú pribalí bundler, sa nepoužíva.
        globIgnores: ['**/assets/ort-wasm-*'],
        maximumFileSizeToCacheInBytes: 80 * 1024 * 1024,
        // Model CLIP si cache-uje transformers.js sám (Cache Storage „transformers-cache“).
      },
    }),
  ],
});

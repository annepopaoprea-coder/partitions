import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg'],
      workbox: {
        importScripts: ['share-target.js'],
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,wasm,bcmap,pfb,ttf,icc}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'Partitions',
        short_name: 'Partitions',
        description: 'Bibliothèque de partitions synchronisée via Google Drive',
        lang: 'fr',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#16161e',
        theme_color: '#16161e',
        // Offered in Android's share menu for PDFs and images.
        share_target: {
          action: 'share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { title: 'title', text: 'text', files: [{ name: 'files', accept: ['application/pdf', 'image/*', '.pdf'] }] },
        },
        // Offered in "Open with" on computers once the app is installed.
        file_handlers: [
          {
            action: './?open-file=1',
            accept: {
              'application/pdf': ['.pdf'],
              'image/jpeg': ['.jpg', '.jpeg'],
              'image/png': ['.png'],
              'image/webp': ['.webp'],
            },
          },
        ],
        launch_handler: { client_mode: 'focus-existing' },
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
    }),
  ],
});

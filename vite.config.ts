import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Golf HCP Tracker',
        short_name: 'Golf HCP',
        description: 'Offline nutzbarer Golf Handicap Tracker fuer Runden, Differentials und HCP-Entwicklung.',
        theme_color: '#1D9E75',
        background_color: '#f5f4f0',
        display: 'standalone',
        orientation: 'portrait',
        lang: 'de',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
})

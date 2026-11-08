import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  server:{proxy:{'/api':'http://localhost:8787','/health':'http://localhost:8787','/routing':{target:'https://valhalla1.openstreetmap.de',changeOrigin:true,rewrite:p=>p.replace(/^\/routing/,''),headers:{'X-Client-Id':'commutr-local-development'}}}},
  preview:{proxy:{'/api':'http://localhost:8787','/health':'http://localhost:8787','/routing':{target:'https://valhalla1.openstreetmap.de',changeOrigin:true,rewrite:p=>p.replace(/^\/routing/,''),headers:{'X-Client-Id':'commutr-local-development'}}}},
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    injectRegister: false,
    includeAssets: ['commutr-logo.png', 'apple-touch-icon.png', 'green-flow.png'],
    manifest: {
      id: '/', name: 'Commutr', short_name: 'Commutr',
      description: 'A little greener, every journey.',
      start_url: '/', scope: '/', display: 'standalone',
      background_color: '#fff9ee', theme_color: '#fff9ee',
      icons: [
        {src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
        {src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
        {src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'}
      ]
    },
    workbox: {
      // Explicit because injectRegister:false disables the plugin’s autoUpdate defaults.
      skipWaiting: true,
      clientsClaim: true,
      globPatterns: ['**/*.{js,css,png,svg,woff2}'],
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      navigateFallback: null,
      runtimeCaching: [
        {urlPattern: ({request})=>request.mode==='navigate',handler:'NetworkFirst',options:{cacheName:'commutr-pages',networkTimeoutSeconds:3,cacheableResponse:{statuses:[200]}}},
        {urlPattern: /^https:\/\/fonts\.googleapis\.com\//, handler: 'StaleWhileRevalidate', options: {cacheName:'google-font-styles'}},
        {urlPattern: /^https:\/\/fonts\.gstatic\.com\//, handler: 'CacheFirst', options: {cacheName:'google-font-files', expiration:{maxEntries:12,maxAgeSeconds:31536000},cacheableResponse:{statuses:[0,200]}}}
      ]
    }
  })]
});

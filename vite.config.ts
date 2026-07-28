import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * BASE_PATH existe por causa do GitHub Pages: um "project site" é servido em
 * /<nome-do-repositorio>/, e sem esse prefixo os assets dão 404. Localmente e
 * em domínio próprio o valor é "/", que é o padrão.
 */
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})

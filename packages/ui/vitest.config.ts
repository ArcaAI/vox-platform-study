import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@/components/ui', replacement: resolve(__dirname, './src/components/shadcn') },
      { find: '@/components/data-table', replacement: resolve(__dirname, './src/components/registries/diceui/data-table') },
      { find: '@', replacement: resolve(__dirname, './src') },
      { find: 'react', replacement: resolve(__dirname, 'node_modules/react') },
      { find: 'react-dom', replacement: resolve(__dirname, 'node_modules/react-dom') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/components/__tests__/vitest-setup.ts'],
    include: ['src/**/*.vitest.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'playwright'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/components/registries/**', 'src/hooks/registries/**'],
      exclude: ['**/__stories__/**', '**/__tests__/**', '**/index.ts'],
    },
    typecheck: {
      enabled: false,
    },
    passWithNoTests: true,
  },
})

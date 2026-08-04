import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  optimizeDeps: {
    // `@arcaai/vox/compat` reaches its audio stack through DYNAMIC imports
    // (`import('@arcaai/stt')`, `'@arcaai/vad'`, `'@arcaai/noise-filter'`, plus
    // the optional `'@arcaai/med-ner'`/`'highlight.run'`). Vite's scanner only
    // sees static imports, so it discovers these the first time you press
    // Start — re-runs the dep optimizer, swaps the `.vite/deps` directory, and
    // the import the page already had in flight dies with
    // "Failed to fetch dynamically imported module".
    //
    // Naming them here puts them in the FIRST optimize pass, so there is no
    // re-run to race. They are transitive deps of vox and (under pnpm's strict
    // layout) not resolvable from this app's root, hence the `a > b` form.
    include: [
      '@arcaai/vox/compat',
      '@arcaai/vox > @arcaai/stt',
      '@arcaai/vox > @arcaai/vad',
      '@arcaai/vox > @arcaai/noise-filter',
      '@arcaai/vox > @arcaai/med-ner',
      '@arcaai/vox > highlight.run',
    ],
  },
});

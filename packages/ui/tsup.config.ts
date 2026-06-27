import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // react-pdf + pdfjs-dist are browser-only and heavy; keep them external so the
  // consuming app's bundler code-splits the lazy PdfRenderer import and resolves
  // the pdf.js worker asset (D3). They are runtime deps of @arcaai/ui.
  external: ['react', 'react-dom', 'react-hook-form', 'react-pdf', 'pdfjs-dist'],
  treeshake: true,
  splitting: false,
  esbuildOptions(options) {
    options.banner = {
      js: '"use client";',
    };
  },
});
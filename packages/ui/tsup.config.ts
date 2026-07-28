import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/index.ts` is the root barrel. `src/components/shared/index.ts` is shipped
  // as a dedicated subpath entry so `@arcaai/ui/components/shared` (StatusBadge /
  // StatusColorRole — intentionally kept off the root barrel) ships a matching
  // `dist/components/shared/index.d.ts` for type-only consumers like apps/admin.
  entry: ['src/index.ts', 'src/components/shared/index.ts', 'src/components/metrics/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // react-pdf + pdfjs-dist are browser-only and heavy; keep them external so the
  // consuming app's bundler resolves the pdf.js worker asset (D3). They are runtime
  // deps of @arcaai/ui.
  external: ['react', 'react-dom', 'react-hook-form', 'react-pdf', 'pdfjs-dist'],
  treeshake: true,
  // MUST stay true. `PdfRenderer` pulls in `pdf-document.tsx` — which statically imports
  // react-pdf → pdf.js, whose module init touches the browser-only `DOMMatrix` — via
  // `React.lazy(() => import('./pdf-document.js'))`. With splitting:false, esbuild inlines
  // that dynamic import into the root barrel and hoists the `react-pdf` import to the top
  // of `index.mjs`, so it evaluates eagerly and crashes SSR ("DOMMatrix is not defined").
  // splitting:true keeps pdf-document (and react-pdf) in a lazy chunk, off the SSR path.
  splitting: true,
  esbuildOptions(options) {
    options.banner = {
      js: '"use client";',
    };
  },
});

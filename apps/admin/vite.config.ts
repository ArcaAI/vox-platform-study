import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Resolve `@arcaai/ui/<subpath>` imports to the library SOURCE (tree-shakeable)
 * instead of the 2.2 MB built barrel (which pulls three.js / maplibre / leaflet).
 * Mirrors the ui-playground plugin, extended to also resolve the new TASK-372
 * component folders via `<subpath>/index.{ts,tsx}`.
 */
function resolveArcaUiSubpaths(): Plugin {
    const uiPkgRoot = resolve(__dirname, '../../packages/ui');
    const uiSrcRoot = resolve(uiPkgRoot, 'src');
    const appSrcRoot = resolve(__dirname, 'src');

    const tryFiles = (base: string): string | undefined => {
        const candidates = [`${base}.tsx`, `${base}.ts`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
        return candidates.find((c) => existsSync(c));
    };

    return {
        name: 'resolve-arcaai-ui-subpaths',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source === '@arcaai/ui') return undefined;

            if (source.startsWith('@arcaai/ui/')) {
                const subpath = source.slice('@arcaai/ui/'.length);
                if (subpath === 'styles.css') {
                    return resolve(uiPkgRoot, 'dist/styles.css');
                }
                if (subpath === 'hooks/use-mobile') {
                    return resolve(uiSrcRoot, 'hooks/use-mobile.ts');
                }
                // direct file / folder index (covers components/data-grid, lib/shared, …)
                const fromSubpath = tryFiles(resolve(uiSrcRoot, subpath));
                if (fromSubpath) return fromSubpath;
                // shadcn primitive shorthand: '@arcaai/ui/button' → components/shadcn/button
                const shadcn = tryFiles(resolve(uiSrcRoot, `components/shadcn/${subpath}`));
                if (shadcn) return shadcn;
                const customIndex = resolve(uiSrcRoot, `components/custom/${subpath}/index.ts`);
                if (existsSync(customIndex)) return customIndex;
                return resolve(uiSrcRoot, `${subpath}.tsx`);
            }

            if (source.startsWith('@/')) {
                const subpath = source.slice('@/'.length);
                const fromUi = importer?.startsWith(uiSrcRoot) ?? false;
                const srcRoot = fromUi ? uiSrcRoot : appSrcRoot;
                // @arcaai/ui's own tsconfig aliases `@/components/ui/*` →
                // `components/shadcn/*` (its vendored registries use that path).
                const rewritten =
                    fromUi && subpath.startsWith('components/ui/') ? `components/shadcn/${subpath.slice('components/ui/'.length)}` : subpath;
                const found = tryFiles(resolve(srcRoot, rewritten));
                if (found) return found;
                return resolve(srcRoot, `${rewritten}.tsx`);
            }
        },
    };
}

export default defineConfig({
    plugins: [
        resolveArcaUiSubpaths(),
        tanstackRouter({
            target: 'react',
            autoCodeSplitting: true,
        }),
        react(),
        tailwindcss(),
    ],
    server: {
        port: 5174,
        host: true,
        proxy: {
            // TASK-391 (D1) — scope the proxy to the versioned API prefix only.
            // The broad `/api` key shadowed the `/api-keys` client route on a hard
            // load (dev forwarded it to the gateway → 404). Narrowing to `/api/v1`
            // is safe: the admin SDK targets an absolute base URL (see
            // `lib/api-config.ts`) and no dev call relies on a non-`/api/v1` path.
            '/api/v1': {
                target: 'http://localhost:8868',
                changeOrigin: true,
            },
            '/ws': {
                target: 'http://localhost:8868',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: process.env.NODE_ENV === 'production' ? false : true,
    },
});

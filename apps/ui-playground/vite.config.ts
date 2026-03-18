import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

function resolveArcaUiSubpaths(): Plugin {
    const uiPkgRoot = resolve(__dirname, '../../packages/ui');
    const uiSrcRoot = resolve(uiPkgRoot, 'src');
    const appSrcRoot = resolve(__dirname, 'src');

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
                const direct = resolve(uiSrcRoot, `${subpath}.tsx`);
                if (existsSync(direct)) return direct;
                const directTs = resolve(uiSrcRoot, `${subpath}.ts`);
                if (existsSync(directTs)) return directTs;
                const customIndex = resolve(uiSrcRoot, `components/custom/${subpath}/index.ts`);
                if (existsSync(customIndex)) return customIndex;
                const shadcn = resolve(uiSrcRoot, `components/shadcn/${subpath}.tsx`);
                if (existsSync(shadcn)) return shadcn;
                return direct;
            }

            if (source.startsWith('@/')) {
                const subpath = source.slice('@/'.length);
                const srcRoot = importer?.startsWith(uiSrcRoot) ? uiSrcRoot : appSrcRoot;
                const extensions = ['.tsx', '.ts', '.js', '.jsx'];
                for (const ext of extensions) {
                    const candidate = resolve(srcRoot, `${subpath}${ext}`);
                    if (existsSync(candidate)) return candidate;
                }
                const indexTs = resolve(srcRoot, subpath, 'index.ts');
                if (existsSync(indexTs)) return indexTs;
                const indexTsx = resolve(srcRoot, subpath, 'index.tsx');
                if (existsSync(indexTsx)) return indexTsx;
                return resolve(srcRoot, `${subpath}.tsx`);
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
    resolve: {
        alias: {},
    },
    server: {
        port: 5175,
        host: true,
        proxy: {
            '/api': {
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

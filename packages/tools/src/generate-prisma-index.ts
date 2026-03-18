#!/usr/bin/env ts-node
/**
 * Script to generate index.ts for Prisma generated client
 *
 * Usage:
 *   pnpm exec ts-node packages/tools/src/generate-prisma-index.ts [path-to-generated-client]
 *
 * If no path is provided, defaults to packages/database/src/generated/core-prisma-client
 */

import * as fs from 'fs';
import * as path from 'path';
import { generatePrismaIndex } from './prisma-commander/utils/generatePrismaIndex';

/**
 * Find the monorepo root by looking for pnpm-workspace.yaml or turbo.json
 */
function findMonorepoRoot(startPath: string): string {
    let currentPath = startPath;
    const maxDepth = 10;
    let depth = 0;

    while (depth < maxDepth) {
        if (fs.existsSync(path.join(currentPath, 'pnpm-workspace.yaml'))) {
            return currentPath;
        }
        if (fs.existsSync(path.join(currentPath, 'turbo.json'))) {
            return currentPath;
        }

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
        depth++;
    }

    // Fallback: assume __dirname is in packages/tools/src
    return path.resolve(__dirname, '..', '..', '..');
}

async function main() {
    const args = process.argv.slice(2);

    // Find monorepo root dynamically
    const monorepoRoot = findMonorepoRoot(process.cwd());
    console.log(`Monorepo root: ${monorepoRoot}`);

    // Default path to generated client (relative to monorepo root)
    const defaultPath = path.resolve(
        monorepoRoot,
        'packages/database/src/generated/core-prisma-client'
    );

    const generatedClientPath = args[0] || defaultPath;
    const absolutePath = path.isAbsolute(generatedClientPath)
        ? generatedClientPath
        : path.resolve(monorepoRoot, generatedClientPath);

    console.log(`Generating index.ts for Prisma client at: ${absolutePath}`);

    try {
        await generatePrismaIndex(absolutePath);
        console.log('✅ Index file generated successfully!');
    } catch (error) {
        console.error('❌ Failed to generate index file:', error);
        process.exit(1);
    }
}

main();

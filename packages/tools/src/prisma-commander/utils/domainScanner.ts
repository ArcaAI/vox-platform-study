import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Domain } from '../types';
import { Logger } from '../../utils/Logger';

const logger = new Logger('DomainScanner');

/**
 * Find the monorepo root by looking for pnpm-workspace.yaml or package.json with workspaces
 */
function findMonorepoRoot(startPath: string): string {
  let currentPath = startPath;
  const maxDepth = 10; // Prevent infinite loop
  let depth = 0;

  while (depth < maxDepth) {
    // Check for pnpm-workspace.yaml (pnpm monorepo indicator)
    if (fs.existsSync(path.join(currentPath, 'pnpm-workspace.yaml'))) {
      return currentPath;
    }

    // Check for turbo.json (Turborepo indicator)
    if (fs.existsSync(path.join(currentPath, 'turbo.json'))) {
      return currentPath;
    }

    // Move up one directory
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      // Reached filesystem root
      break;
    }
    currentPath = parentPath;
    depth++;
  }

  // Fallback: assume we're in packages/tools
  return path.resolve(startPath, '..', '..');
}

/**
 * Scans for available Prisma schema domains
 */
export async function scanPrismaDomains(): Promise<Domain[]> {
  try {
    // Find monorepo root from current working directory
    const monorepoRoot = findMonorepoRoot(process.cwd());
    const prismaDir = path.resolve(monorepoRoot, 'packages', 'database', 'src', 'prisma');

    logger.info(`Monorepo root: ${monorepoRoot}`);
    logger.info(`Looking for Prisma schemas in: ${prismaDir}`);

    if (!fs.existsSync(prismaDir)) {
      logger.error(`Prisma directory not found: ${prismaDir}`);
      return [];
    }

    // Find all schema.prisma files in the database/prisma directory
    const schemaFiles = await glob('*/schema.prisma', { cwd: prismaDir });

    if (!schemaFiles || schemaFiles.length === 0) {
      logger.warn('No Prisma schema files found');
      return [];
    }

    // Filter out db_snomed folder and map the found schema files to domain objects
    const domains: Domain[] = schemaFiles
      .filter((schemaFile: string) => !schemaFile.startsWith('db_snomed/'))
      .map((schemaFile: string) => {
        const domainName = path.dirname(schemaFile);
        return {
          name: domainName,
          schemaFilePath: path.resolve(prismaDir, schemaFile),
          path: path.resolve(prismaDir, schemaFile).replace('/schema.prisma', '')
        };
      });

    logger.info(`Found ${domains.length} Prisma domains (excluding db_snomed)`);
    return domains;
  } catch (error) {
    logger.error('Error scanning for Prisma domains', error);
    return [];
  }
}
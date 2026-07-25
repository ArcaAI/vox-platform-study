import path from 'path';
import fs from 'fs';
import { getDMMF, getConfig, getSchemaWithPath } from '@prisma/internals';
import { getPnpmWorkspaceNodeModulesPath } from './getNodeModulesPath';
import Logger from './Logger';
import { DMMF } from './getPrismaDMMF';

const logger = new Logger('prismaSchema');

/**
 * A Prisma "domain": a workspace package that declares a `prisma.schema` path.
 *
 * On Prisma 7 the generated client no longer lives at `node_modules/.prisma/*`
 * and no longer exposes `Prisma.dmmf`, so DMMF is derived directly from the
 * schema files (via `@prisma/internals`) rather than from a generated client.
 */
export interface PrismaDomain {
  name: string;
  value: string;
  /** Absolute path to the Prisma schema (file or multi-file folder) for this domain. */
  schemaPath: string;
  /** Loaded multi-file Prisma schema tuples ([path, content]) used to derive DMMF/config. */
  schemas: unknown;
}

/**
 * Discover the domains to generate from.
 *
 * A "domain" is any workspace package whose package.json declares a `prisma.schema`
 * path. The domain name is derived from the package's Prisma generator `output`
 * (e.g. `core-prisma-client` → `core`) so the generated folder layout stays stable.
 * Domains are sorted by name so output is deterministic.
 */
export async function discoverPrismaDomains(workspaceRoot?: string): Promise<PrismaDomain[]> {
  const root = workspaceRoot ?? path.dirname(getPnpmWorkspaceNodeModulesPath());
  const domains: PrismaDomain[] = [];

  for (const packageDir of listWorkspacePackageDirs(root)) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson: { prisma?: { schema?: string } };
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      continue;
    }

    const schemaRelative = packageJson.prisma?.schema;
    if (!schemaRelative) {
      continue;
    }

    const schemaPath = path.resolve(packageDir, schemaRelative);
    if (!fs.existsSync(schemaPath)) {
      continue;
    }

    try {
      const { schemas } = await getSchemaWithPath({ schemaPath: { cliProvidedPath: schemaPath } });
      const name = await deriveDomainName(schemas);
      domains.push({ name, value: name, schemaPath, schemas });
    } catch (error) {
      logger.warn(`Skipping schema at ${path.relative(root, schemaPath)}: ${errorMessage(error)}`);
    }
  }

  return domains.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Derive the Prisma DMMF directly from a domain's loaded schema (Prisma 7 way).
 */
export async function getDMMFForDomain(domain: PrismaDomain): Promise<DMMF> {
  return (await getDMMF({ datamodel: domain.schemas as never })) as unknown as DMMF;
}

/**
 * Expand the root package.json "workspaces" globs (e.g. `packages/*`) into concrete
 * package directories. Falls back to the conventional layout if not declared.
 */
function listWorkspacePackageDirs(workspaceRoot: string): string[] {
  let patterns: string[] = ['packages/*', 'apps/*'];
  try {
    const rootPackageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'));
    if (Array.isArray(rootPackageJson.workspaces) && rootPackageJson.workspaces.length > 0) {
      patterns = rootPackageJson.workspaces;
    }
  } catch {
    // Use the default patterns.
  }

  const directories: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const baseDir = path.join(workspaceRoot, pattern.slice(0, -2));
      if (fs.existsSync(baseDir)) {
        for (const entry of fs.readdirSync(baseDir).sort()) {
          const fullPath = path.join(baseDir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            directories.push(fullPath);
          }
        }
      }
    } else {
      const fullPath = path.join(workspaceRoot, pattern);
      if (fs.existsSync(fullPath)) {
        directories.push(fullPath);
      }
    }
  }

  return directories;
}

/**
 * Derive a stable domain name from the Prisma generator output directory
 * (e.g. `../../generated/core-prisma-client` → `core`).
 */
async function deriveDomainName(schemas: unknown): Promise<string> {
  const config = await getConfig({ datamodel: schemas as never });
  const output = config.generators?.[0]?.output?.value;
  if (output) {
    return path.basename(output).replace(/-prisma-client$/, '');
  }
  return 'core';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

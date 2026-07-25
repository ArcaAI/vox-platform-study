import { ActivityConfig, Domain, ActivityOptions } from '../types';
import { runCommand } from '../../utils/runCommand';
import { Logger } from '../../utils/Logger';
import { generatePrismaIndex, findGeneratedClientPath } from './generatePrismaIndex';
import * as path from 'path';

const logger = new Logger('PrismaActivities');

/**
 * Get the monorepo root directory from the schema path
 * Prisma 7 requires running from the directory containing prisma.config.ts (monorepo root)
 */
function getMonorepoRoot(schemaPath: string): string {
  const parts = schemaPath.split(path.sep);
  const packagesIndex = parts.indexOf('packages');
  if (packagesIndex > 0) {
    return parts.slice(0, packagesIndex).join(path.sep);
  }
  return path.resolve(schemaPath, '..', '..', '..', '..', '..');
}

/**
 * Get relative schema path from monorepo root
 */
function getRelativeSchemaPath(schemaPath: string, monorepoRoot: string): string {
  return path.relative(monorepoRoot, schemaPath);
}

/**
 * Find monorepo root from current working directory
 */
function findMonorepoRootFromCwd(): string {
  const cwd = process.cwd();
  const parts = cwd.split(path.sep);
  const packagesIndex = parts.indexOf('packages');
  return packagesIndex > 0 ? parts.slice(0, packagesIndex).join(path.sep) : path.resolve(cwd, '..', '..');
}

// ============================================================================
// Activity Implementations
// ============================================================================

/**
 * Execute Prisma generate client command for a domain
 */
async function executeGenerateClient(domain: Domain): Promise<void> {
  logger.info(`Generating Prisma client for domain: ${domain.name}`);

  const monorepoRoot = getMonorepoRoot(domain.path);
  const relativeSchemaPath = getRelativeSchemaPath(domain.path, monorepoRoot);
  const command = `pnpm exec prisma generate --schema=${relativeSchemaPath}`;

  try {
    await runCommand({ command, cwd: monorepoRoot });
    logger.info(`Client generated for domain: ${domain.name}`);

    // Generate index.ts for the generated client
    const generatedClientPath = findGeneratedClientPath(domain.path);
    if (generatedClientPath) {
      await generatePrismaIndex(generatedClientPath);
      logger.info(`Index file generated for domain: ${domain.name}`);
    } else {
      logger.warn(`Could not find generated client path for domain: ${domain.name}`);
    }
  } catch (error) {
    logger.error(`Failed to generate client for domain: ${domain.name}`, error);
    throw error;
  }
}

/**
 * Execute Prisma DB push command for a domain
 */
async function executeDbPush(domain: Domain, force: boolean = false): Promise<void> {
  const action = force ? 'Force pushing' : 'Pushing';
  logger.info(`${action} database schema for domain: ${domain.name}`);

  const monorepoRoot = getMonorepoRoot(domain.path);
  const relativeSchemaPath = getRelativeSchemaPath(domain.path, monorepoRoot);

  let command = `pnpm exec prisma db push --schema=${relativeSchemaPath}`;
  if (force) {
    command += ' --force-reset --accept-data-loss';
  }

  try {
    await runCommand({ command, cwd: monorepoRoot });
    logger.info(`Schema push completed for domain: ${domain.name}`);
  } catch (error) {
    logger.error(`Failed to push schema for domain: ${domain.name}`, error);
    throw error;
  }
}

/**
 * Execute Prisma migrate dev command for a domain
 */
async function executeCreateMigration(domain: Domain, migrationName?: string): Promise<void> {
  logger.info(`Creating migration for domain: ${domain.name}`);

  const monorepoRoot = getMonorepoRoot(domain.path);
  const relativeSchemaPath = getRelativeSchemaPath(domain.path, monorepoRoot);
  const name = migrationName || `migration_${Date.now()}`;
  const command = `pnpm exec prisma migrate dev --schema=${relativeSchemaPath} --name=${name}`;

  try {
    await runCommand({ command, cwd: monorepoRoot });
    logger.info(`Migration "${name}" created for domain: ${domain.name}`);
  } catch (error) {
    logger.error(`Failed to create migration for domain: ${domain.name}`, error);
    throw error;
  }
}

/**
 * Execute database seed command
 */
async function executeSeed(): Promise<void> {
  logger.info('Running database seeds...');

  const monorepoRoot = findMonorepoRootFromCwd();
  const command = 'pnpm seed';

  try {
    await runCommand({ command, cwd: monorepoRoot });
    logger.info('Database seeding completed');
  } catch (error) {
    logger.error('Failed to run database seeds', error);
    throw error;
  }
}

/**
 * Start Prisma Studio for a domain
 */
async function executeStartStudio(domain: Domain): Promise<void> {
  logger.info(`Starting Prisma Studio for domain: ${domain.name}`);

  const monorepoRoot = getMonorepoRoot(domain.path);
  const relativeSchemaPath = getRelativeSchemaPath(domain.path, monorepoRoot);
  const command = `pnpm exec prisma studio --schema=${relativeSchemaPath}`;

  try {
    await runCommand({ command, cwd: monorepoRoot });
    logger.info(`Prisma Studio started for domain: ${domain.name}`);
  } catch (error) {
    logger.error(`Failed to start Prisma Studio for domain: ${domain.name}`, error);
    throw error;
  }
}

// ============================================================================
// Activity Handlers (called by CLI)
// ============================================================================

async function handleGenerate(domains: Domain[]): Promise<void> {
  logger.info(`Regenerating Prisma clients for ${domains.length} domain(s)`);
  for (const domain of domains) {
    await executeGenerateClient(domain);
  }
  logger.info('Prisma clients regenerated for all selected domains');
}

async function handlePush(domains: Domain[], options?: ActivityOptions): Promise<void> {
  const force = options?.force ?? false;
  logger.info(`${force ? 'Force pushing' : 'Pushing'} schema for ${domains.length} domain(s)`);
  for (const domain of domains) {
    await executeDbPush(domain, force);
  }
  logger.info('Schema push completed for all selected domains');
}

async function handlePushForce(domains: Domain[]): Promise<void> {
  return handlePush(domains, { force: true });
}

async function handleMigrate(domains: Domain[], options?: ActivityOptions): Promise<void> {
  logger.info(`Creating migrations for ${domains.length} domain(s)`);
  for (const domain of domains) {
    await executeCreateMigration(domain, options?.migrationName);
  }
  logger.info('Migrations created for all selected domains');
}

async function handleSeed(_domains: Domain[]): Promise<void> {
  logger.info('Running database seeds (applies to all domains)');
  await executeSeed();
}

async function handleStudio(domains: Domain[]): Promise<void> {
  if (domains.length > 1) {
    logger.warn('Can only start Prisma Studio for one domain at a time. Using the first selected domain.');
  }
  await executeStartStudio(domains[0]);
}

// ============================================================================
// Activity Configuration
// ============================================================================

/**
 * Available Prisma activities configuration
 */
export const prismaActivities: ActivityConfig[] = [
  {
    name: 'generate',
    label: 'Generate Clients',
    description: 'Regenerate Prisma clients for selected domains',
    execute: handleGenerate,
  },
  {
    name: 'push',
    label: 'Push Schema',
    description: 'Push schema to database (db push)',
    execute: handlePush,
  },
  {
    name: 'push:force',
    label: 'Push Schema (Force Reset)',
    description: 'Force push schema with data loss (db push --force-reset)',
    execute: handlePushForce,
  },
  {
    name: 'migrate',
    label: 'Create Migration',
    description: 'Create a new migration (migrate dev)',
    execute: handleMigrate,
  },
  {
    name: 'seed',
    label: 'Run Seeds',
    description: 'Run database seed scripts',
    execute: handleSeed,
  },
  {
    name: 'studio',
    label: 'Prisma Studio',
    description: 'Start Prisma Studio for database inspection',
    execute: handleStudio,
  },
];

/**
 * Get activity by name
 */
export function getActivityByName(name: string): ActivityConfig | undefined {
  return prismaActivities.find((a) => a.name === name);
}

/**
 * Get all activity names
 */
export function getActivityNames(): string[] {
  return prismaActivities.map((a) => a.name);
}

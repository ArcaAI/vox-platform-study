#!/usr/bin/env node

import { Command } from 'commander';
import path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import figlet from 'figlet';
import { scanPrismaDomains } from './utils/domainScanner';
import { runInteractiveCLI, listActivities, listDomains } from './utils/cli';
import { getActivityByName, getActivityNames } from './utils/activities';
import { Logger } from '../utils/Logger';
// Importing this module loads the env file for the current NODE_ENV. It is the
// package's only env loader; the NODE_ENV -> file map and the host-env-wins
// precedence live in `packages/applications/src/common/env/env-file-resolution`.
import { findMonorepoRoot } from '../utils/loadEnv';
import { Domain, CLIOptions, ActivityOptions } from './types';

const monorepoRoot = findMonorepoRoot() ?? path.resolve(__dirname, '..', '..', '..', '..');

const logger = new Logger('PrismaCommander');

/**
 * Display header for non-interactive mode
 */
function displayHeader(): void {
  console.log(
    chalk.cyan(
      figlet.textSync('Prisma Commander', {
        font: 'Standard',
        horizontalLayout: 'default',
        verticalLayout: 'default',
      }),
    ),
  );
  console.log(chalk.yellow('A Prisma CLI utility for managing database operations\n'));
}

/**
 * Resolve domains from CLI options
 */
function resolveDomains(allDomains: Domain[], options: CLIOptions): Domain[] {
  if (options.all) {
    return allDomains;
  }

  if (options.domain && options.domain.length > 0) {
    const selectedDomains: Domain[] = [];
    for (const domainName of options.domain) {
      const domain = allDomains.find((d) => d.name === domainName);
      if (!domain) {
        logger.error(`Domain not found: ${domainName}`);
        logger.info(`Available domains: ${allDomains.map((d) => d.name).join(', ')}`);
        process.exit(1);
      }
      selectedDomains.push(domain);
    }
    return selectedDomains;
  }

  return [];
}

/**
 * Run in non-interactive mode
 */
async function runNonInteractive(allDomains: Domain[], options: CLIOptions): Promise<void> {
  displayHeader();

  // Resolve activity
  const activity = getActivityByName(options.activity!);
  if (!activity) {
    logger.error(`Unknown activity: ${options.activity}`);
    logger.info(`Available activities: ${getActivityNames().join(', ')}`);
    process.exit(1);
  }

  // Resolve domains
  const domains = resolveDomains(allDomains, options);
  if (domains.length === 0) {
    logger.error('No domains specified. Use --domain <name> or --all');
    process.exit(1);
  }

  // Build activity options
  const activityOptions: ActivityOptions = {};
  if (options.migrationName) {
    activityOptions.migrationName = options.migrationName;
  }
  if (options.force) {
    activityOptions.force = true;
  }

  // Log execution details
  logger.info(`Activity: ${activity.label}`);
  logger.info(`Domains: ${domains.map((d) => d.name).join(', ')}`);

  // Warn on destructive operations
  if (activity.name === 'push:force' && !options.force) {
    logger.warn('Force push will RESET the database and DELETE ALL DATA');
    logger.warn('Use --force to confirm this operation');
    process.exit(1);
  }

  // Execute
  await activity.execute(domains, activityOptions);
  logger.info('Operation completed successfully');
}

/**
 * Main CLI program
 */
const program = new Command();

program.name('prisma-commander').description('A Prisma CLI utility for managing database operations').version('1.0.0');

// Interactive mode (default)
program
  .command('interactive', { isDefault: true })
  .description('Run in interactive mode with prompts')
  .action(async () => {
    const spinner = ora('Scanning for Prisma domains...').start();

    try {
      const domains = await scanPrismaDomains();

      if (domains.length === 0) {
        spinner.fail('No Prisma domains found');
        process.exit(1);
      }

      spinner.succeed(`Found ${domains.length} Prisma domains`);

      const { activity, domains: selectedDomains, options } = await runInteractiveCLI(domains);
      await activity.execute(selectedDomains, options);

      logger.info('Operation completed successfully');
    } catch (error) {
      spinner.fail('Error running Prisma Commander');
      logger.error('Failed to execute', error);
      process.exit(1);
    }
  });

// Generate command
program
  .command('generate')
  .description('Regenerate Prisma clients')
  .option('-d, --domain <names...>', 'Domain name(s) to process')
  .option('-a, --all', 'Process all domains')
  .action(async (opts) => {
    await runWithActivity('generate', opts);
  });

// Push command
program
  .command('push')
  .description('Push schema to database (db push)')
  .option('-d, --domain <names...>', 'Domain name(s) to process')
  .option('-a, --all', 'Process all domains')
  .option('-f, --force', 'Force reset (--force-reset --accept-data-loss)')
  .action(async (opts) => {
    const activity = opts.force ? 'push:force' : 'push';
    await runWithActivity(activity, { ...opts, force: opts.force });
  });

// Migrate command
program
  .command('migrate')
  .description('Create a new migration')
  .option('-d, --domain <names...>', 'Domain name(s) to process')
  .option('-a, --all', 'Process all domains')
  .option('-n, --name <name>', 'Migration name')
  .action(async (opts) => {
    await runWithActivity('migrate', { ...opts, migrationName: opts.name });
  });

// Seed command
program
  .command('seed')
  .description('Run database seed scripts')
  .action(async () => {
    await runWithActivity('seed', { all: true });
  });

// Studio command
program
  .command('studio')
  .description('Start Prisma Studio')
  .option('-d, --domain <name>', 'Domain name to open')
  .action(async (opts) => {
    if (!opts.domain) {
      logger.error('Please specify a domain with --domain <name>');
      process.exit(1);
    }
    await runWithActivity('studio', { domain: [opts.domain] });
  });

// List activities command
program
  .command('list:activities')
  .alias('la')
  .description('List available activities')
  .action(() => {
    listActivities();
  });

// List domains command
program
  .command('list:domains')
  .alias('ld')
  .description('List available Prisma domains')
  .action(async () => {
    const spinner = ora('Scanning for Prisma domains...').start();
    const domains = await scanPrismaDomains();
    spinner.stop();
    listDomains(domains);
  });

/**
 * Helper to run an activity with options
 */
async function runWithActivity(activityName: string, opts: Omit<CLIOptions, 'activity'>): Promise<void> {
  const spinner = ora('Scanning for Prisma domains...').start();

  try {
    const allDomains = await scanPrismaDomains();

    if (allDomains.length === 0) {
      spinner.fail('No Prisma domains found');
      process.exit(1);
    }

    spinner.succeed(`Found ${allDomains.length} Prisma domains`);

    const cliOptions: CLIOptions = {
      activity: activityName,
      domain: opts.domain,
      all: opts.all,
      force: opts.force,
      migrationName: opts.migrationName,
    };

    await runNonInteractive(allDomains, cliOptions);
  } catch (error) {
    spinner.fail('Error running Prisma Commander');
    logger.error('Failed to execute', error);
    process.exit(1);
  }
}

// Parse arguments
program.parse(process.argv);

// If no arguments provided, show help
if (process.argv.length === 2) {
  program.help();
}

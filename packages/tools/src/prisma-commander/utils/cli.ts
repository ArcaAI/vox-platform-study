import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import { ActivityConfig, Domain, PrismaCommandOptions, ActivityOptions } from '../types';
import { Logger } from '../../utils/Logger';
import { prismaActivities } from './activities';

const logger = new Logger('PrismaCLI');

/**
 * Display CLI header
 */
export function displayHeader(): void {
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
 * Prompt for activity selection
 */
async function promptForActivity(): Promise<ActivityConfig> {
  const { activity } = await inquirer.prompt([
    {
      type: 'list',
      name: 'activity',
      message: 'Select an activity to perform:',
      choices: prismaActivities.map((act) => ({
        name: `${chalk.green(act.name.padEnd(12))} ${act.label} - ${chalk.gray(act.description)}`,
        value: act,
      })),
    },
  ]);

  return activity;
}

/**
 * Prompt for domain selection
 */
async function promptForDomains(availableDomains: Domain[]): Promise<Domain[]> {
  const choices = [
    { name: chalk.yellow('All domains'), value: 'all' },
    new inquirer.Separator(),
    ...availableDomains.map((domain) => ({
      name: domain.name,
      value: domain.name,
    })),
  ];

  const { selectedDomains } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedDomains',
      message: 'Select domains to process:',
      choices,
      validate: (answer: string[]) => {
        if (answer.length < 1) {
          return 'You must select at least one domain';
        }
        return true;
      },
    },
  ]);

  if (selectedDomains.includes('all')) {
    return availableDomains;
  }

  return availableDomains.filter((domain) => selectedDomains.includes(domain.name));
}

/**
 * Prompt for migration name (only for migrate activity)
 */
async function promptForMigrationName(): Promise<string | undefined> {
  const { migrationName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'migrationName',
      message: 'Enter migration name (leave empty for auto-generated):',
      default: '',
    },
  ]);

  return migrationName || undefined;
}

/**
 * Prompt for confirmation on destructive operations
 */
async function promptForConfirmation(message: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: chalk.red(message),
      default: false,
    },
  ]);

  return confirmed;
}

/**
 * Run interactive CLI to get user selections
 */
export async function runInteractiveCLI(availableDomains: Domain[]): Promise<PrismaCommandOptions> {
  try {
    displayHeader();

    if (availableDomains.length === 0) {
      logger.error('No Prisma domains found to process');
      process.exit(1);
    }

    // Get activity selection
    const activity = await promptForActivity();
    logger.info(`Selected activity: ${activity.name}`);

    // Get domain selections
    const domains = await promptForDomains(availableDomains);
    logger.info(`Selected ${domains.length} domain(s)`);

    // Get additional options based on activity
    const options: ActivityOptions = {};

    if (activity.name === 'migrate') {
      options.migrationName = await promptForMigrationName();
    }

    if (activity.name === 'push:force') {
      const confirmed = await promptForConfirmation('This will RESET the database and DELETE ALL DATA. Are you sure?');
      if (!confirmed) {
        logger.info('Operation cancelled by user');
        process.exit(0);
      }
    }

    return { activity, domains, options };
  } catch (error) {
    logger.error('Error in CLI interaction', error);
    process.exit(1);
  }
}

/**
 * List available activities
 */
export function listActivities(): void {
  console.log(chalk.cyan('\nAvailable activities:\n'));

  for (const activity of prismaActivities) {
    console.log(`  ${chalk.green(activity.name.padEnd(12))} ${activity.label}`);
    console.log(`  ${' '.repeat(12)} ${chalk.gray(activity.description)}\n`);
  }
}

/**
 * List available domains
 */
export function listDomains(domains: Domain[]): void {
  console.log(chalk.cyan('\nAvailable domains:\n'));

  if (domains.length === 0) {
    console.log(chalk.yellow('  No domains found'));
    return;
  }

  for (const domain of domains) {
    console.log(`  ${chalk.green(domain.name)}`);
    console.log(`  ${chalk.gray(domain.path)}\n`);
  }
}

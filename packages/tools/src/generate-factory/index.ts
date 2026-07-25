#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { generateFactories } from './generator';
import { Logger } from '../utils/Logger';
import { getPnpmWorkspaceNodeModulesPath } from '../utils';
// Load environment variables using centralized utility
import '../utils/loadEnv';

// Initialize logger
const logger = new Logger('generate-factory');

const program = new Command();

program
  .name('generate-factory')
  .description('Generate factory classes from entity class files')
  .option('-e, --entity-path <path>', 'Directory containing entity class files', 'packages/domains/src/entities')
  .option('-o, --output <path>', 'Output directory for generated factories', 'packages/domains/src/factories')
  .option('-w, --overwrite', 'Overwrite existing factory files', false)
  .parse(process.argv);

const options = program.opts();

// Resolve paths to absolute
const currentDir = getPnpmWorkspaceNodeModulesPath(process.cwd());
const entityPath = resolve(currentDir, '..', options.entityPath);
const outputPath = resolve(currentDir, '..', options.output);
const overwrite = options.overwrite || false;

logger.info('Starting factory generation...');
logger.debug(`Entity path: ${entityPath}`);
logger.debug(`Output path: ${outputPath}`);
logger.debug(`Overwrite: ${overwrite}`);
logger.debug('Domain folders will be preserved in output structure');

generateFactories({
  entityPath,
  outputPath,
  overwrite,
})
  .then(() => {
    logger.info('✨ Factory generation completed successfully');
  })
  .catch((error) => {
    logger.error('Error generating factories:', error);
    process.exit(1);
  });

#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { generateMappers } from './generator';
import { Logger } from '../utils/Logger';
// Load environment variables using centralized utility
import '../utils/loadEnv';

// Initialize logger
const logger = new Logger('generate-mapper');

const program = new Command();

program
  .name('generate-mapper')
  .description('Generate mapper classes from entity and model classes')
  .option('-o, --output <path>', 'Output directory for generated mappers')
  .option('-e, --entity <path>', 'Directory containing entity class files')
  .option('-m, --model <path>', 'Directory containing model class files')
  .parse(process.argv);

const options = program.opts();

// Resolve paths to absolute
const outputBasePath = options.output || resolve(process.env.OUTPUT_PATH || '../');
const outputPath = resolve(outputBasePath, 'domains/src/mappers', 'generated');
const entityPath = resolve(options.entity || resolve(outputBasePath, 'domains', 'src', 'entities', 'generated'));
const modelPath = resolve(options.model || resolve(outputBasePath, 'domains', 'src', 'models', 'generated'));

logger.info('Starting mapper generation...');
logger.debug(`Entity path: ${entityPath}`);
logger.debug(`Model path: ${modelPath}`);
logger.debug(`Output path: ${outputPath}`);
logger.debug('Domain folders will be preserved in output structure');

generateMappers({
  basePath: outputBasePath,
  outputPath,
  entityPath,
  modelPath,
})
  .then(() => {
    logger.info('✨ Mapper generation completed successfully');
  })
  .catch((error) => {
    logger.error('Error generating mappers:', error);
    process.exit(1);
  });

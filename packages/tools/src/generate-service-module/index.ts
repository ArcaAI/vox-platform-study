#!/usr/bin/env node
import { program } from 'commander';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import generateServiceModule, { ServiceModuleGeneratorOptions } from './generator';
import { Logger } from '../utils/Logger';

const logger = new Logger('generate-service-module');

interface DomainModel {
  name: string;
  path: string;
  domain: string;
}

async function scanDomainModels(): Promise<Record<string, DomainModel[]>> {
  const modelsPath = path.resolve(process.cwd(), '../../', 'packages/domains/src/models/generated');

  logger.info(`Scanning for models in: ${modelsPath}`);

  if (!fs.existsSync(modelsPath)) {
    logger.warn(`Models directory not found: ${modelsPath}`);
    return {};
  }

  // First approach: scan all model files recursively
  const modelsByDomain: Record<string, DomainModel[]> = {};

  // Find all Model.ts files in the entire directory structure
  const allModelFiles = await glob('**/*Model.ts', { cwd: modelsPath });

  logger.info(`Found ${allModelFiles.length} model files in the directory structure`);

  // Process each model file to determine its domain
  for (const modelFile of allModelFiles) {
    // The domain is the top-level directory
    // For example, from 'core/auth/UserModel.ts', we extract 'core'
    const pathParts = modelFile.split(path.sep);
    const domain = pathParts[0];

    if (!domain) continue;

    // Initialize domain array if not already present
    if (!modelsByDomain[domain]) {
      modelsByDomain[domain] = [];
    }

    // Add the model to its domain
    modelsByDomain[domain].push({
      name: path.basename(modelFile, '.ts').replace('Model', ''),
      path: path.join(modelsPath, modelFile),
      domain,
    });
  }

  // If we didn't find any models with the above approach, try a different directory structure
  if (Object.keys(modelsByDomain).length === 0) {
    logger.info('No models found with standard structure, trying alternate scanning method...');

    try {
      // Get all immediate subdirectories
      const topDirs = fs.readdirSync(modelsPath).filter((item) => fs.statSync(path.join(modelsPath, item)).isDirectory());

      logger.info(`Found ${topDirs.length} top-level directories to scan`);

      for (const dir of topDirs) {
        const dirPath = path.join(modelsPath, dir);
        const files = await glob('**/*Model.ts', { cwd: dirPath });

        logger.info(`Found ${files.length} model files in ${dir} directory`);

        if (files.length > 0) {
          modelsByDomain[dir] = files.map((file: string) => ({
            name: path.basename(file, '.ts').replace('Model', ''),
            path: path.join(dirPath, file),
            domain: dir,
          }));
        }
      }
    } catch (error) {
      logger.error('Error scanning alternate directory structure:', error);
    }
  }

  // Summary of what we found
  const domainCount = Object.keys(modelsByDomain).length;
  const totalModels = Object.values(modelsByDomain).reduce((sum, models) => sum + models.length, 0);

  logger.info(`Scan complete. Found ${totalModels} models across ${domainCount} domains`);

  // Print details of each domain and its models (limited to first 5 models per domain for brevity)
  Object.entries(modelsByDomain).forEach(([domain, models]) => {
    const sampleModels = models
      .slice(0, 5)
      .map((m) => m.name)
      .join(', ');
    const moreCount = models.length > 5 ? ` and ${models.length - 5} more` : '';
    logger.info(`Domain: ${domain} - ${models.length} models: ${sampleModels}${moreCount}`);
  });

  return modelsByDomain;
}

async function promptForOptions(): Promise<ServiceModuleGeneratorOptions> {
  const modelsByDomain = await scanDomainModels();
  const domains = Object.keys(modelsByDomain).sort();

  let selectedDomain: string;
  let serviceName: string;

  // Check if any domains were found
  if (domains.length === 0) {
    logger.warn('No domain models found. Make sure the domain models are generated in packages/domains/src/models/generated');
    logger.info('Proceeding with manual service name input...');

    // Ask for custom service name
    const { customName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customName',
        message: 'Enter a service name:',
        validate: (input: string) => {
          if (!input) {
            return 'Service name is required';
          }
          return true;
        },
      },
    ]);
    serviceName = customName;
  } else {
    // First ask for domain
    const domainAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedDomain',
        message: 'Select a domain for the service:',
        choices: [...domains, 'Other'],
      },
    ]);
    selectedDomain = domainAnswer.selectedDomain;

    if (selectedDomain === 'Other') {
      // If "Other" selected, ask for custom service name
      const { customName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customName',
          message: 'Enter a custom service name:',
          validate: (input: string) => {
            if (!input) {
              return 'Service name is required';
            }
            return true;
          },
        },
      ]);
      serviceName = customName;
    } else {
      // If domain selected, show models from that domain
      const domainModels = modelsByDomain[selectedDomain];

      // Handle potential empty domain (could happen with complex directory structures)
      if (!domainModels || domainModels.length === 0) {
        logger.warn(`No models found in domain: ${selectedDomain}`);

        // Collect all models from all domains as a fallback
        const allModels: DomainModel[] = [];
        Object.values(modelsByDomain).forEach((models) => allModels.push(...models));

        if (allModels.length > 0) {
          logger.info(`Showing all available models (${allModels.length} total) as a fallback`);

          // Sort all models alphabetically
          const sortedAllModels = allModels.sort((a, b) => a.name.localeCompare(b.name));

          const { selectedModelFromAll } = await inquirer.prompt([
            {
              type: 'list',
              name: 'selectedModelFromAll',
              message: 'Select a model from all available:',
              choices: sortedAllModels.map((model) => ({
                name: `${model.domain}/${model.name}`,
                value: model.name,
              })),
            },
          ]);

          serviceName = selectedModelFromAll;
        } else {
          // If somehow we got here with no models, ask for custom name
          const { customName } = await inquirer.prompt([
            {
              type: 'input',
              name: 'customName',
              message: 'Enter a custom service name:',
              validate: (input: string) => {
                if (!input) {
                  return 'Service name is required';
                }
                return true;
              },
            },
          ]);
          serviceName = customName;
        }
      } else {
        // Sort models alphabetically
        const sortedModels = domainModels.sort((a, b) => a.name.localeCompare(b.name));

        const { selectedModel } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedModel',
            message: `Select a model from ${selectedDomain}:`,
            choices: sortedModels.map((model) => ({
              name: model.name,
              value: model.name,
            })),
          },
        ]);

        serviceName = selectedModel;
      }
    }
  }

  // Continue with the rest of the options
  const { outputPath, serviceGroupFolderPath, overwrite } = await inquirer.prompt([
    {
      type: 'input',
      name: 'outputPath',
      message: 'What is the output path for the service?',
      default: '../../packages/applications/src/services',
    },
    {
      type: 'input',
      name: 'serviceGroupFolderPath',
      message: 'Optional: Path to the service group folder (leave empty for root services folder)',
    },
    {
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite existing files?',
      default: false,
    },
  ]);

  return {
    name: serviceName,
    outputPath,
    serviceGroupFolderPath,
    overwrite,
  };
}

async function main(): Promise<void> {
  program
    .name('generate-service-module')
    .description('Generate a new service module for @arcaai/applications')
    .option('-o, --output-path <path>', 'Output path for the service')
    .option('-n, --name <name>', 'Service name')
    .option('-g, --service-group-folder-path <path>', 'Path to the service group folder')
    .option('--overwrite', 'Overwrite existing files', false)
    .parse(process.argv);

  const options = program.opts<ServiceModuleGeneratorOptions>();

  let generatorOptions: ServiceModuleGeneratorOptions;

  // If no options provided via CLI, prompt user
  if (!options.name) {
    generatorOptions = await promptForOptions();
  } else {
    generatorOptions = {
      outputPath: options.outputPath || '../../packages/applications/src/services',
      name: options.name,
      serviceGroupFolderPath: options.serviceGroupFolderPath,
      overwrite: options.overwrite,
    };
  }

  try {
    await generateServiceModule(generatorOptions);
    logger.info('Service module generation completed successfully');
  } catch (error) {
    logger.error('Error generating service module:', error);
    process.exit(1);
  }
}

// When called directly (not imported)
if (require.main === module) {
  main();
}

export { generateServiceModule };
export default generateServiceModule;

#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as handlebars from 'handlebars';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { Paths } from '../utils';

// Register Handlebars helpers
handlebars.registerHelper('lowercase', function (str) {
  return str.toLowerCase();
});

interface GenerateRepositoryOptions {
  output: string;
  overwrite: boolean;
  domain?: string;
  entity?: string;
  skipIndex?: boolean;
}

interface EntityInfo {
  entityName: string; // e.g., 'UserEntity'
  modelName: string; // e.g., 'User'
  repositoryName: string; // e.g., 'UserRepository'
  mapperName: string; // e.g., 'UserEntityMapper'
  domain: string; // e.g., 'Core'
  modelInstanceName: string; // e.g., 'user'
}

/**
 * Get all available domains from entities directory
 */
function getDomains(): string[] {
  const domainsPath = Paths.getEntitiesPath();

  if (!fs.existsSync(domainsPath)) {
    console.error(chalk.red('Domains directory not found:', domainsPath));
    process.exit(1);
  }

  return fs.readdirSync(domainsPath).filter((item) => fs.statSync(path.join(domainsPath, item)).isDirectory());
}

/**
 * Get all entities in a specific domain
 */
function getEntitiesForDomain(domain: string): string[] {
  const entitiesPath = Paths.getDomainEntitiesPath(domain);

  if (!fs.existsSync(entitiesPath)) {
    console.error(chalk.red(`Domain directory not found: ${entitiesPath}`));
    process.exit(1);
  }

  return fs
    .readdirSync(entitiesPath)
    .filter((item) => item.endsWith('Entity.ts'))
    .map((item) => item.replace('.ts', ''));
}

/**
 * Extract entity info needed for repository generation
 */
function getEntityInfo(domain: string, entityName: string): EntityInfo {
  // Convert domain name to proper case (first letter uppercase)
  const properDomain = domain.charAt(0).toUpperCase() + domain.slice(1).toLowerCase();

  // Remove 'Entity' suffix to get base name
  const baseName = entityName.replace('Entity', '');

  // Model name does not have 'Entity' suffix
  const modelName = baseName;

  // Repository name is base name + 'Repository'
  const repositoryName = `${baseName}Repository`;

  // Mapper name is base name + 'Mapper'
  const mapperName = `${baseName}EntityMapper`;

  // Model instance name is camelCase of base name
  const modelInstanceName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

  return {
    entityName,
    modelName,
    repositoryName,
    mapperName,
    domain: properDomain,
    modelInstanceName,
  };
}

/**
 * Generate repository file
 */
async function generateRepositoryFile(entityInfo: EntityInfo, options: GenerateRepositoryOptions): Promise<string> {
  const { output, overwrite } = options;
  const { repositoryName, domain } = entityInfo;

  const outputPath = output ? path.resolve(Paths.getWorkspacePath(), output) : Paths.getRepositoriesPath();

  // Read the template file
  const templatePath = Paths.getTemplatePath('repository', 'repository');
  const templateContent = fs.readFileSync(templatePath, 'utf-8');

  // Compile the template
  const template = handlebars.compile(templateContent);

  // Create output directory path based on domain
  const outputDir = domain ? path.join(outputPath, domain.toLowerCase()) : Paths.getDomainRepositoriesPath(domain);

  // Ensure output directory exists
  Paths.ensureDirectoryExists(outputDir);

  const outputFile = path.join(outputDir, `${repositoryName}.ts`);

  // Check if file exists and handle overwrite
  if (fs.existsSync(outputFile) && !overwrite) {
    console.error(chalk.yellow(`File ${outputFile} already exists. Use --overwrite to force overwrite.`));
    return outputFile;
  }

  // Generate the content
  const generatedContent = template(entityInfo);

  // Write the file
  fs.writeFileSync(outputFile, generatedContent);

  return outputFile;
}

/**
 * Generate index files for repositories
 */
function generateIndexFiles(domains: string[]): string[] {
  console.log(chalk.blue('Generating index files for repositories...'));

  const indexFiles = Paths.generateIndicesForType('repository', domains);

  return indexFiles;
}

/**
 * Generate repositories for a specific domain or all domains
 */
async function generateRepositories(options: GenerateRepositoryOptions) {
  const { domain, entity, skipIndex } = options;

  let domains: string[] = [];
  const generatedFiles: string[] = [];
  let selectedAll = false;

  if (domain) {
    domains = [domain];
  } else {
    // Get all domains
    domains = await getDomains();

    // Add "All domains" option at the beginning of the choices
    const domainChoices = [{ name: 'All domains', value: 'all' }, ...domains.map((d) => ({ name: d, value: d }))];

    // Prompt user to select domains if none specified
    const { selectedDomains } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedDomains',
        message: 'Select domains to generate repositories for:',
        choices: domainChoices,
      },
    ]);

    // If "All domains" is selected, use all domains, otherwise use selected ones
    if (selectedDomains.includes('all')) {
      domains = domains;
      selectedAll = true;
    } else {
      domains = selectedDomains;
    }
  }

  // For each selected domain
  for (const domainName of domains) {
    let entities: string[] = [];

    if (entity) {
      entities = [entity];
    } else {
      // Get all entities for this domain
      entities = getEntitiesForDomain(domainName);

      // If user didn't select "All domains", prompt to select entities
      if (!selectedAll) {
        // Prompt user to select entities
        const { selectedEntities } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'selectedEntities',
            message: `Select entities for ${domainName} domain:`,
            choices: entities,
          },
        ]);

        entities = selectedEntities;
      }
    }

    // For each selected entity
    for (const entityName of entities) {
      // Get entity information
      const entityInfo = getEntityInfo(domainName, entityName);

      // Generate repository file
      const outputFile = await generateRepositoryFile(entityInfo, options);
      generatedFiles.push(outputFile);

      console.log(chalk.green(`Generated repository file: ${outputFile}`));
    }
  }

  // Generate index files if not explicitly skipped
  if (!skipIndex) {
    const indexFiles = generateIndexFiles(domains);

    for (const indexFile of indexFiles) {
      console.log(chalk.green(`Generated index file: ${indexFile}`));
    }
  }

  return generatedFiles;
}

const program = new Command();

program
  .name('generate-repository')
  .description('Generate repository files from templates')
  .option('-o, --output <path>', 'Output directory for generated files')
  .option('--overwrite', 'Overwrite existing files', false)
  .option('-d, --domain <name>', 'Specify a domain to generate repositories for')
  .option('-e, --entity <name>', 'Specify an entity to generate a repository for')
  .option('--skip-index', 'Skip generation of index files', false)
  .action(async (options) => {
    try {
      const files = await generateRepositories(options);
      console.log(chalk.green(`Successfully generated ${files.length} repository files.`));
    } catch (error) {
      console.error(chalk.red('Error generating repositories:'), error);
      process.exit(1);
    }
  });

program.parse(process.argv);

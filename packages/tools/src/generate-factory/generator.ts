import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import Handlebars from 'handlebars';
import * as inquirer from 'inquirer';
import { Logger, parseEntityFile, EntityMetadata, checkDirectory, toCamelCase, generateIndices, Paths } from '../utils';

// Initialize logger
const logger = new Logger('generate-factory:generator');

export interface GenerateFactoryOptions {
  entityPath: string;
  outputPath: string;
  overwrite: boolean;
}

interface FactoryData {
  entityName: string;
  entityInterfaceName: string;
  factoryName: string;
  properties: Array<{
    name: string;
    isOptional: boolean;
    defaultValue: string;
  }>;
  hasDecimal: boolean;
}

interface EntityChoice {
  file: string;
  domain: string;
}

// Register Handlebars helper for removing Entity suffix
Handlebars.registerHelper('removeEntitySuffix', function (entityName: string) {
  return entityName.replace('Entity', '');
});

export async function generateFactories(options: GenerateFactoryOptions): Promise<void> {
  const { entityPath, outputPath, overwrite } = options;

  // Ensure directories exist
  if (!existsSync(entityPath)) {
    throw new Error(`Entities directory not found: ${entityPath}`);
  }

  mkdirSync(outputPath, { recursive: true });

  // Find all entity folders
  const entityFolders = fs
    .readdirSync(entityPath)
    .filter((folder) => fs.statSync(path.join(entityPath, folder)).isDirectory())
    .map((folder) => ({
      name: folder,
      value: folder,
      folderPath: path.resolve(entityPath, folder),
    }));

  // Add "All domains" option
  entityFolders.unshift({
    name: 'All domains',
    value: 'all',
    folderPath: '',
  });

  // Ask user to select domains
  const { selectedDomain } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedDomain',
      message: 'Select a domain to generate factories for:',
      choices: entityFolders,
    },
  ]);

  let domainsToProcess: string[] = [];
  if (selectedDomain === 'all') {
    domainsToProcess = entityFolders.filter((folder) => folder.value !== 'all').map((folder) => folder.value);
  } else {
    // If specific domain selected, ask for specific entities
    const domainPath = path.join(entityPath, selectedDomain);
    const entityFiles = await glob('**/*Entity.ts', { cwd: domainPath });

    if (entityFiles.length === 0) {
      logger.warn(`No entity files found in ${domainPath}`);
      return;
    }

    const entityChoices = entityFiles.map((file) => ({
      name: path.basename(file, '.ts'),
      value: {
        file,
        domain: selectedDomain,
      } as EntityChoice,
    }));

    // Add "All entities" option
    entityChoices.unshift({
      name: 'All entities',
      value: 'all' as any,
    });

    const { selectedEntity } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedEntity',
        message: 'Select an entity to generate factory for:',
        choices: entityChoices,
      },
    ]);

    if (selectedEntity === 'all') {
      domainsToProcess = [selectedDomain];
    } else {
      // Process a single entity
      await processEntity(
        path.join(entityPath, selectedEntity.domain, selectedEntity.file),
        path.join(outputPath, selectedEntity.domain),
        selectedEntity.file,
        overwrite,
      );
      logger.info('Factory generation completed successfully');
      return;
    }
  }

  // Process selected domains
  const domainMappers: Record<string, string[]> = {};
  for (const domain of domainsToProcess) {
    const domainPath = path.join(entityPath, domain);
    const entityFiles = await glob('**/*Entity.ts', { cwd: domainPath });

    if (entityFiles.length === 0) {
      logger.warn(`No entity files found in ${domainPath}`);
      continue;
    }

    logger.info(`Processing ${entityFiles.length} entities in domain: ${domain}`);

    for (const entityFile of entityFiles) {
      const entityFullPath = path.join(domainPath, entityFile);
      const outputDomainPath = path.join(outputPath, domain);
      const factoryName = await processEntity(entityFullPath, outputDomainPath, entityFile, overwrite);

      if (factoryName) {
        if (!domainMappers[domain]) {
          domainMappers[domain] = [];
        }
        domainMappers[domain].push(factoryName);
      }
    }
  }

  // Generate index files for each domain
  logger.info('Generating index files for domains');
  // await generateDomainIndexFiles(domainMappers, outputPath);

  // Generate root index file that exports all domain indexes
  logger.info('Generating root index file');
  const indexFiles = Paths.generateIndicesForType('factory', domainsToProcess);

  logger.info('Factory generation completed successfully');
}

async function processEntity(entityPath: string, outputPath: string, entityFile: string, overwrite: boolean): Promise<string | null> {
  try {
    const entityInfo = parseEntityFile(entityPath);
    const factoryName = `${entityInfo.entityName.replace('Entity', '')}Factory`;

    // Create output directory for this domain if it doesn't exist
    if (!existsSync(outputPath)) {
      mkdirSync(outputPath, { recursive: true });
    }

    // Determine the subdirectory structure (if any)
    const subDirPath = path.dirname(entityFile);
    const factoryOutputPath = subDirPath === '.' ? outputPath : path.join(outputPath, subDirPath);

    // Create the subdirectory if needed
    if (subDirPath !== '.' && !existsSync(factoryOutputPath)) {
      mkdirSync(factoryOutputPath, { recursive: true });
    }

    const outputFile = path.join(factoryOutputPath, `${factoryName}.ts`);

    // Check if factory already exists
    if (existsSync(outputFile) && !overwrite) {
      logger.info(`Factory already exists (skipping): ${outputFile}`);
      return factoryName;
    }

    // Prepare factory data
    const factoryData = generateFactoryData(entityInfo, factoryName);

    // Load and compile template
    const templatePath = path.join(__dirname, 'templates', 'factory.hbs');
    const templateContent = readFileSync(templatePath, 'utf-8');
    const template = Handlebars.compile(templateContent);

    // Generate factory content
    const content = template(factoryData);
    writeFileSync(outputFile, content, 'utf-8');

    logger.debug(`Generated factory: ${outputFile}`);
    return factoryName;
  } catch (error) {
    logger.error(`Error processing entity ${entityPath}:`, error);
    return null;
  }
}

function generateFactoryData(entityInfo: EntityMetadata, factoryName: string): FactoryData {
  // Check if any property uses Decimal
  const hasDecimal = entityInfo.properties.some((prop) => prop.type.includes('Decimal') || prop.type.includes('decimal.js'));

  // Custom logic to add some properties due to the inheritance
  if (entityInfo.properties.some((x) => x.name === 'Tags')) {
    // Find the index of the Tenant property
    const tagsIndex = entityInfo.properties.findIndex((prop) => prop.name === 'Tags');

    // Insert tags property before the Tenant property
    entityInfo.properties.splice(tagsIndex, 0, {
      name: 'tags',
      type: 'string[]',
      isOptional: true,
      isRelationship: false,
      isArray: true,
    });
  }
  if (entityInfo.properties.some((x) => x.name === 'Tenant')) {
    // Find the index of the Tenant property
    const tenantIndex = entityInfo.properties.findIndex((prop) => prop.name === 'Tenant');

    entityInfo.properties[tenantIndex].isOptional = true;
    entityInfo.properties[tenantIndex].isRelationship = true;

    // Insert tenantId property before the Tenant property
    entityInfo.properties.splice(tenantIndex, 0, {
      name: 'tenantId',
      type: 'string',
      isOptional: true,
      isRelationship: false,
      isArray: false,
    });
  }

  // Map entity properties to factory properties
  const properties = entityInfo.properties.map((prop) => {
    // Determine default value based on property type
    let defaultValue = 'null';

    if (prop.type.includes('[]') || prop.type.includes('Array') || prop.isArray) {
      defaultValue = '[]';
    } else if (prop.type.includes('string') && !prop.isArray) {
      defaultValue = '""';
    } else if (prop.type.includes('number') && !prop.isArray) {
      defaultValue = '0';
    } else if (prop.type.includes('boolean') && !prop.isArray) {
      defaultValue = 'false';
    } else if (prop.type.includes('Date') && !prop.isArray) {
      defaultValue = 'new Date()';
    } else if (prop.type.includes('Decimal') && !prop.isArray) {
      defaultValue = 'new Decimal(0)';
    }

    return {
      name: prop.name,
      isOptional: prop.isOptional,
      defaultValue,
    };
  });

  return {
    entityName: entityInfo.entityName,
    entityInterfaceName: entityInfo.interfaceName,
    factoryName,
    properties,
    hasDecimal,
  };
}

async function generateDomainIndexFiles(domainFactories: Record<string, string[]>, outputPath: string): Promise<void> {
  for (const [domain, factories] of Object.entries(domainFactories)) {
    const domainOutputPath = path.join(outputPath, domain);
    const indexContent = factories.map((factory) => `export * from './${factory}';`).join('\n') + '\n';
    const indexPath = path.join(domainOutputPath, 'index.ts');
    writeFileSync(indexPath, indexContent, 'utf-8');
    logger.debug(`Generated domain index: ${indexPath}`);
  }
}

async function generateRootIndexFile(domains: string[], outputPath: string): Promise<void> {
  const indexContent =
    domains
      .filter((domain) => domain) // Skip empty domain
      .map((domain) => `export * from './${domain}';`)
      .join('\n') + '\n';

  const rootIndexPath = path.join(outputPath, 'index.ts');
  writeFileSync(rootIndexPath, indexContent, 'utf-8');
  logger.debug(`Generated root index: ${rootIndexPath}`);
}

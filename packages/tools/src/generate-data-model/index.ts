#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { program } from 'commander';
import inquirer from 'inquirer';
import Handlebars from 'handlebars';
import { DMMF } from '@prisma/generator-helper';
import { SelectedItem, DomainFolder, CommandLineOptions, ProcessingOptions } from './types';
import { Logger, getPrismaDMMF, checkDirectory, names, getPnpmWorkspaceNodeModulesPath } from '../utils';
// Load environment variables using centralized utility
import '../utils/loadEnv';

// Initialize logger for this file
const logger = new Logger('Generate Data Model');

// Define the main function to run the CLI utility
async function main() {
  try {
    const options = await setupCommandLineOptions();
    setupDirectories(options.outputModelsPath, options.enumsOutputPath);

    const nodeModulesPath = getPnpmWorkspaceNodeModulesPath();
    const prismaPath = path.resolve(nodeModulesPath, '.prisma');

    if (!checkDirectory(prismaPath)) {
      logger.error('The .prisma directory does not exist in node_modules.');
      logger.error('Please generate the Prisma clients first.');
      process.exit(1);
    }

    const domainFolders = discoverDomainFolders(prismaPath);
    if (domainFolders.length === 0) {
      logger.error('No Prisma client folders found in .prisma directory.');
      logger.error('Please generate the Prisma clients first.');
      process.exit(1);
    }

    const selectedDomains = await selectDomains(domainFolders);
    const modelTemplateSource = fs.readFileSync(path.resolve(__dirname, 'templates', 'model.hbs'), 'utf-8');
    const modelTemplate = Handlebars.compile(modelTemplateSource);

    const isAllDomains = selectedDomains.length === domainFolders.length;
    const allSelectedItems: SelectedItem[] = [];

    for (const domain of selectedDomains) {
      const domainItems = await processDomain(domain, options, modelTemplate, isAllDomains);
      if (domainItems) {
        allSelectedItems.push(...domainItems);
      }
    }

    // Generate root index files
    generateRootIndexFiles(options, selectedDomains, allSelectedItems);

    logger.info('Data model generation completed successfully.');
  } catch (error) {
    logger.error(`Error generating data models: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function setupCommandLineOptions(): Promise<ProcessingOptions> {
  program
    .name('generate-data-model')
    .description('Generate TypeScript data model and enum files from Prisma schema')
    .option('-o, --output-path <path>', 'Output directory for generated files')
    .option('--overwrite <boolean>', 'Whether to overwrite existing files (true/false)', (value) => {
      if (value !== 'true' && value !== 'false') {
        throw new Error('overwrite option must be either "true" or "false"');
      }
      return value === 'true';
    })
    .parse(process.argv);

  const options = program.opts<CommandLineOptions>();
  const shouldOverwrite = options.overwrite ?? false;

  const outputBasePath = options.outputPath || path.resolve(process.env.OUTPUT_PATH || '..');
  const outputModelsPath = path.resolve(outputBasePath, 'domains/src/models', 'generated');
  const enumsOutputPath = path.resolve(outputBasePath, 'domains/src/enums', 'generated');

  return { outputModelsPath, enumsOutputPath, shouldOverwrite };
}

function setupDirectories(outputModelsPath: string, enumsOutputPath: string): void {
  if (!fs.existsSync(outputModelsPath)) {
    fs.mkdirSync(outputModelsPath, { recursive: true });
  }

  if (!fs.existsSync(enumsOutputPath)) {
    fs.mkdirSync(enumsOutputPath, { recursive: true });
  }
}

function discoverDomainFolders(prismaPath: string): DomainFolder[] {
  return fs
    .readdirSync(prismaPath)
    .filter((folder) => folder.match(/^(.+)(-prisma-client)$/))
    .map((folder) => {
      const domainName = folder.replace(/(.+)(-prisma-client)$/, '$1');
      return {
        name: domainName,
        value: folder,
        folderPath: path.resolve(prismaPath, folder),
        module: `.prisma/${folder}`,
      };
    });
}

async function selectDomains(domainFolders: DomainFolder[]): Promise<DomainFolder[]> {
  const { selectedDomains } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedDomains',
      message: 'Select domains to generate models for:',
      choices: [{ name: 'All domains', value: 'all' }, ...domainFolders.map((domain) => ({ name: domain.name, value: domain.value }))],
    },
  ]);

  return selectedDomains === 'all' ? domainFolders : domainFolders.filter((domain) => domain.value === selectedDomains);
}

async function selectItemsForDomain(
  models: DMMF.Model[],
  enums: DMMF.DatamodelEnum[],
  domain: DomainFolder,
  isAllDomains: boolean,
): Promise<SelectedItem[]> {
  if (isAllDomains) {
    return [
      ...models.map((model) => ({ type: 'model' as const, name: model.name, data: model })),
      ...enums.map((enumItem) => ({ type: 'enum' as const, name: enumItem.name, data: enumItem })),
    ];
  }

  const { selectedItems } = await inquirer.prompt<{ selectedItems: SelectedItem[] }>([
    {
      type: 'checkbox',
      name: 'selectedItems',
      message: `Select models and enums to generate for domain ${domain.name}:`,
      choices: [
        new inquirer.Separator('--- Models ---'),
        ...models.map((model) => ({ name: model.name, value: { type: 'model', name: model.name, data: model } })),
        new inquirer.Separator('--- Enums ---'),
        ...enums.map((enumItem) => ({ name: enumItem.name, value: { type: 'enum', name: enumItem.name, data: enumItem } })),
      ],
      pageSize: 20,
    },
  ]);

  return selectedItems;
}

function generateEnumFile(
  enumItem: SelectedItem,
  enumsOutputPath: string,
  modelTemplate: HandlebarsTemplateDelegate,
  shouldOverwrite: boolean,
): void {
  const className = names(enumItem.data.name).className;
  const enumValues = (enumItem.data as DMMF.DatamodelEnum).values.map((value) => ({
    name: value.name,
  }));

  const enumFileContent = modelTemplate({
    className,
    enumValues,
    hasDecimal: false,
    baseModel: '',
    scalarFields: [],
    relationFields: [],
  });

  const enumFilePath = path.resolve(enumsOutputPath, `${className}.ts`);

  if (fs.existsSync(enumFilePath) && !shouldOverwrite) {
    logger.info(`Skipping existing enum file: ${enumFilePath}`);
    return;
  }

  fs.writeFileSync(enumFilePath, enumFileContent);
  logger.info(`${fs.existsSync(enumFilePath) ? 'Overwrote' : 'Generated'} enum file: ${className}.ts`);
}

function generateModelFile(
  modelItem: SelectedItem,
  domainOutputPath: string,
  modelTemplate: HandlebarsTemplateDelegate,
  shouldOverwrite: boolean,
): void {
  // Only ever called for items collected with type: 'model'.
  const model = modelItem.data as DMMF.Model;
  const className = names(model.name).className;

  let baseModel = 'BaseDataModel';
  if (model.fields.find((f) => /tenantId/.test(f.name))) {
    baseModel = 'BaseTenantDataModel';
  }
  if (/audit/i.test(model.name)) {
    baseModel = '';
  }

  const { scalarFields, hasDecimal } = composeScalarEnumFields(model.fields, baseModel);
  const relationFields = composeRelationFields(model.fields);

  const modelFileContent = modelTemplate({
    className,
    enumValues: [],
    hasDecimal,
    baseModel,
    scalarFields,
    relationFields,
  });

  const { className: modelClassName } = names(model.name);
  const modelFilePath = path.resolve(domainOutputPath, `${modelClassName}Model.ts`);

  if (fs.existsSync(modelFilePath) && !shouldOverwrite) {
    logger.info(`Skipping existing model file: ${modelFilePath}`);
    return;
  }

  fs.writeFileSync(modelFilePath, modelFileContent);
  logger.info(`${fs.existsSync(modelFilePath) ? 'Overwrote' : 'Generated'} model file: ${modelClassName}Model.ts`);
}

function generateDomainIndexFile(domainOutputPath: string, selectedItems: SelectedItem[]): void {
  const modelItems = selectedItems.filter((item) => item.type === 'model');
  if (modelItems.length === 0) return;

  const modelExports = modelItems
    .map((item) => {
      const { className } = names(item.name);
      return `export * from './${className}Model';`;
    })
    .join('\n');

  const indexFilePath = path.resolve(domainOutputPath, 'index.ts');
  // Delete the file if it exists
  if (fs.existsSync(indexFilePath)) {
    fs.unlinkSync(indexFilePath);
  }
  fs.writeFileSync(indexFilePath, modelExports);
}

function generateRootIndexFiles(options: ProcessingOptions, selectedDomains: DomainFolder[], allSelectedItems: SelectedItem[]): void {
  // Generate index file for enums
  const enumItems = allSelectedItems.filter((item) => item.type === 'enum');
  if (enumItems.length > 0) {
    const enumExports = enumItems
      .map((item) => {
        const className = names(item.name).className;
        return `export * from './${className}';`;
      })
      .join('\n');

    const enumsIndexPath = path.resolve(options.enumsOutputPath, 'index.ts');
    // Delete the file if it exists
    if (fs.existsSync(enumsIndexPath)) {
      fs.unlinkSync(enumsIndexPath);
    }
    fs.writeFileSync(enumsIndexPath, enumExports);
    logger.info('Generated index.ts file for enums folder');
  }

  // Generate index file for models/generated
  if (selectedDomains.length > 0) {
    const domainExports = selectedDomains.map((domain) => `export * from './${domain.name}';`).join('\n');

    const modelsIndexPath = path.resolve(options.outputModelsPath, 'index.ts');
    // Delete the file if it exists
    if (fs.existsSync(modelsIndexPath)) {
      fs.unlinkSync(modelsIndexPath);
    }
    fs.writeFileSync(modelsIndexPath, domainExports);
    logger.info('Generated index.ts file for models/generated folder');
  }
}

async function processDomain(
  domain: DomainFolder,
  options: ProcessingOptions,
  modelTemplate: HandlebarsTemplateDelegate,
  isAllDomains: boolean,
): Promise<SelectedItem[] | undefined> {
  logger.info(`Processing domain: ${domain.name}`);

  try {
    const dmmf = await getPrismaDMMF(domain.folderPath);
    const { models, enums } = dmmf.datamodel;

    if (!models.length && !enums.length) {
      logger.warn(`No models or enums found in domain ${domain.name}. Skipping.`);
      return;
    }

    const domainOutputPath = path.resolve(options.outputModelsPath, domain.name);
    if (!fs.existsSync(domainOutputPath)) {
      fs.mkdirSync(domainOutputPath, { recursive: true });
    }

    const selectedItems = await selectItemsForDomain(models, enums, domain, isAllDomains);

    for (const item of selectedItems) {
      if (item.type === 'enum') {
        generateEnumFile(item, options.enumsOutputPath, modelTemplate, options.shouldOverwrite);
      } else {
        generateModelFile(item, domainOutputPath, modelTemplate, options.shouldOverwrite);
      }
    }

    generateDomainIndexFile(domainOutputPath, selectedItems);
    logger.info(`Generated index.ts file for domain: ${domain.name}`);

    return selectedItems;
  } catch (error) {
    logger.error(`Error processing domain ${domain.name}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
}

/**
 * Compose scalar and enum fields for a model.
 * @param fields - The fields of the model.
 * @param baseModel - The base model of the model.
 * @returns The scalar and enum fields for the model.
 */
function composeScalarEnumFields(
  fields: readonly DMMF.Field[],
  baseModel: string,
): {
  scalarFields: { name: string; type: string }[];
  hasDecimal: boolean;
} {
  let hasDecimal = false;
  const BASE_MODEL_FIELDS: Record<string, string[]> = {
    BaseDataModel: ['metaData', 'version', 'id', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'],
    BaseTenantDataModel: ['metaData', 'version', 'id', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'tenantId'],
  };

  const MAPPINGS: Record<string, string> = {
    Decimal: 'Decimal',
    Int: 'number',
    Float: 'number',
    String: 'string',
    Boolean: 'boolean',
    DateTime: 'Date',
    Json: 'JsonValue',
  };

  const fieldsToOmit = baseModel ? BASE_MODEL_FIELDS[baseModel] || [] : [];

  const scalarFields = fields
    .filter((field) => field.kind !== 'object')
    .filter((field) => !fieldsToOmit.includes(field.name))
    .map((field) => {
      const { name, type } = field;
      const array = field.isList ? '[]' : '';

      if (field.kind === 'enum') {
        return {
          name,
          type: `Enums.${type}${array} ${field.isRequired ? '' : '| null'}`,
        };
      }

      if (type === 'Decimal') {
        hasDecimal = true;
      }

      return {
        name,
        type: `${MAPPINGS[type] || 'any'}${array} ${field.isRequired ? '' : '| null'}`,
      };
    });

  return { scalarFields, hasDecimal };
}

/**
 * Compose relation fields for a model.
 * @param fields - The fields of the model.
 * @returns The relation fields for the model.
 */
function composeRelationFields(fields: readonly DMMF.Field[]): { name: string; type: string }[] {
  return fields
    .filter((field) => field.kind === 'object')
    .map((field) => {
      const { name, type } = field;
      const array = field.isList ? '[]' : '';
      return { name, type: `Models.${names(type).className}${array}` };
    });
}

// Execute the main function
main().catch((error) => {
  logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

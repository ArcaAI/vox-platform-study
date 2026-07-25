import { glob } from 'glob';
import fs from 'fs';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import path, { join, basename } from 'path';
import * as Handlebars from 'handlebars';
import { DMMF } from '@prisma/generator-helper';
import {
  Logger,
  parseEntityFile,
  parseModelFile,
  EntityMetadata,
  ModelMetadata,
  getPrismaDMMF,
  DMMF as PrismaDMMF,
  checkDirectory,
  getPnpmWorkspaceNodeModulesPath,
  toCamelCase,
} from '../utils';
// Load environment variables using centralized utility
import '../utils/loadEnv';

// Initialize logger
const logger = new Logger('generate-mapper:generator');

interface GenerateMapperOptions {
  basePath: string;
  outputPath: string;
  entityPath: string;
  modelPath: string;
}

interface MapperInfo {
  entityPath: string;
  modelPath: string;
  mapperPath: string;
  mapperName: string;
  domainPath: string;
}

interface MapperData {
  entityName: string;
  modelName: string;
  mapperName: string;
  toPersistenceHandlers: { name: string; code: string }[];
  toDomainHandlers: { name: string; code: string }[];
}

interface DomainFolder {
  name: string;
  value: string;
  folderPath: string;
  module: string;
}

function discoverDomainFolders(prismaPath: string): DomainFolder[] {
  return fs
    .readdirSync(prismaPath)
    .filter((folder) => folder.match(/^(.+)(-prisma-client)$/))
    .map((folder) => {
      const domainName = folder.replace(/(.+)(-prisma-client)/, '$1');
      return {
        name: domainName,
        value: folder,
        folderPath: path.resolve(prismaPath, folder),
        module: `.prisma/${folder}`,
      };
    });
}

export async function generateMappers(options: GenerateMapperOptions): Promise<void> {
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

  const prismaClients: Record<string, PrismaDMMF> = {};
  for (const domainFolder of domainFolders) {
    const dmmf = await getPrismaDMMF(domainFolder.folderPath);
    prismaClients[domainFolder.name] = dmmf;
  }

  const { outputPath, entityPath, modelPath } = options;

  // Ensure directories exist
  if (!existsSync(entityPath)) {
    throw new Error(`Entities directory not found: ${entityPath}`);
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Models directory not found: ${modelPath}`);
  }
  mkdirSync(outputPath, { recursive: true });

  // Find entity and model files
  const entityFiles = await glob('**/*Entity.ts', { cwd: entityPath });
  const modelFiles = await glob('**/*Model.ts', { cwd: modelPath });

  logger.info(`Found ${entityFiles.length} entity files and ${modelFiles.length} model files`);

  // Load and compile template
  const templatePath = join(__dirname, 'templates', 'mapper.hbs');
  const templateContent = readFileSync(templatePath, 'utf-8');
  const template = Handlebars.compile(templateContent);

  // Register helper for equality comparison
  Handlebars.registerHelper('eq', function (a, b) {
    return a === b;
  });

  // Generate mappers
  const mapperInfos: MapperInfo[] = [];
  const domainMappers: Record<string, string[]> = {};

  logger.info('Starting mapper generation');
  for (const entityFile of entityFiles) {
    const modelFile = modelFiles.find((m) => basename(m) === basename(entityFile).replace('Entity.ts', 'Model.ts'));
    const modelName = modelFile && basename(modelFile).replace('Model.ts', '');

    if (modelFile) {
      const domainPath = entityFile.split('/')[0];
      const dmmfData = prismaClients[domainPath].datamodel.models.find((m) => m.name === modelName);
      if (!dmmfData) {
        // The *Model.ts file exists but no matching model is in the Prisma schema;
        // generateMapper would dereference dmmfData.fields and throw.
        logger.warn(`No Prisma model named '${modelName}' in domain '${domainPath}' for entity: ${entityFile}`);
        continue;
      }
      const entityFullPath = join(entityPath, entityFile);
      const modelFullPath = join(modelPath, modelFile);

      const mapperInfo = await generateMapper({
        dmmfData,
        entityPath: entityFullPath,
        modelPath: modelFullPath,
        outputPath,
        template,
        domainPath,
      });

      mapperInfos.push(mapperInfo);

      // Track mappers by domain for index generation
      if (!domainMappers[domainPath]) {
        domainMappers[domainPath] = [];
      }
      domainMappers[domainPath].push(mapperInfo.mapperName);
    } else {
      logger.warn(`Model not found for entity: ${entityFile}`);
    }
  }

  // Generate index files for each domain
  logger.info('Generating index files for domains');
  await generateDomainIndexFiles(domainMappers, outputPath);

  // Generate root index file that exports all domain indexes
  logger.info('Generating root index file');
  await generateRootIndexFile(Object.keys(domainMappers), outputPath);

  logger.info('Mapper generation completed successfully');
}

interface GenerateMapperParams {
  dmmfData: DMMF.Model;
  entityPath: string;
  modelPath: string;
  outputPath: string;
  template: HandlebarsTemplateDelegate;
  domainPath: string;
}

async function generateMapper(params: GenerateMapperParams): Promise<MapperInfo> {
  const { dmmfData, entityPath, modelPath, outputPath, template, domainPath } = params;

  const entityInfo = parseEntityFile(entityPath);
  const modelInfo = parseModelFile(modelPath);

  const mapperName = `${entityInfo.entityName}Mapper`;

  // If there's a domain folder structure, use it
  const mapperOutputPath = domainPath ? join(outputPath, domainPath) : outputPath;

  mkdirSync(mapperOutputPath, { recursive: true });

  const mapperData = generateMapperData(dmmfData, entityInfo, modelInfo, mapperName);
  const content = template(mapperData);
  const outputFile = join(mapperOutputPath, `${mapperName}.ts`);
  writeFileSync(outputFile, content, 'utf-8');
  logger.debug(`Generated mapper: ${outputFile}`);

  return {
    entityPath,
    modelPath,
    mapperPath: mapperOutputPath,
    mapperName,
    domainPath,
  };
}

/**
 * Generate index.ts files for each domain folder
 */
async function generateDomainIndexFiles(domainMappers: Record<string, string[]>, outputPath: string): Promise<void> {
  for (const [domain, mappers] of Object.entries(domainMappers)) {
    const domainOutputPath = domain ? join(outputPath, domain) : outputPath;
    const indexContent = mappers.map((mapper) => `export * from './${mapper}';`).join('\n') + '\n';
    const indexPath = join(domainOutputPath, 'index.ts');
    writeFileSync(indexPath, indexContent, 'utf-8');
    logger.debug(`Generated domain index: ${indexPath}`);
  }
}

/**
 * Generate root index.ts that exports from all domain folders
 */
async function generateRootIndexFile(domains: string[], outputPath: string): Promise<void> {
  const indexContent =
    domains
      .filter((domain) => domain) // Skip empty domain
      .map((domain) => `export * from './${domain}';`)
      .join('\n') + '\n';

  // If we have domains, add the export
  const rootIndexPath = join(outputPath, 'index.ts');
  const finalContent = domains.some((d) => d) ? indexContent : "export * from './*';"; // Export all if no domains

  writeFileSync(rootIndexPath, finalContent, 'utf-8');
  logger.debug(`Generated root index: ${rootIndexPath}`);
}

function generateMapperData(dmmfData: DMMF.Model, entityInfo: EntityMetadata, modelInfo: ModelMetadata, mapperName: string): MapperData {
  // Collect all relationships from both entity and model
  const entityRelationships = entityInfo.properties.filter((p) => p.isRelationship);
  const modelRelationships = modelInfo.properties.filter((p) => p.isRelationship);

  // Create toPersistence handlers for relationships
  const toPersistenceHandlers = entityRelationships
    .map((rel) => {
      const referencedField = dmmfData.fields.find((f) => f.name === rel.name)?.relationFromFields?.[0];

      if (!referencedField) {
        return;
      }

      if (rel.name === 'Tags') {
        return {
          name: 'tags',
          code: `(obj: Entities.${entityInfo.entityName}) => obj.Tags?.map(item => item.id) || []`,
        };
      }
      if (rel.name === 'Tenant') {
        return {
          name: 'tenantId',
          code: `(obj: Entities.${entityInfo.entityName}) => obj.Tenant?.id || null`,
        };
      }

      if (rel.isArray) {
        // return {
        //     name: `${rel.name}Ids`,
        //     code: `(obj: ${entityType}) => obj.${rel.name}?.map(item => item.id) || []`
        // };

        // immediate return for now
        return;
      }

      return {
        name: referencedField || `${toCamelCase(rel.name)}Id`,
        code: `(obj: Entities.${entityInfo.entityName}) => obj.${rel.name}${rel.isOptional ? '?' : ''}.id${rel.isOptional ? ' || null' : ''}`,
      };
    })
    .filter((x) => !!x);

  // Create toDomain handlers for relationships
  const toDomainHandlers = modelRelationships.map((rel) => {
    // const referencedField = dmmfData.fields.find(f => f.name === rel.name)?.relationFromFields?.[0];
    const mapperName = `Mappers.${rel.type.replace('Models.', '')}EntityMapper`;

    if (rel.isArray) {
      return {
        name: rel.name,
        code: `(obj: Models.${modelInfo.modelName}) => obj.${rel.name}?.map(item => ${mapperName}.getInstance().toDomainEntity(item)) || []`,
      };
    } else {
      return {
        name: rel.name,
        code: `(obj: Models.${modelInfo.modelName}) => obj.${rel.name} ? ${mapperName}.getInstance().toDomainEntity(obj.${rel.name}) : null`,
      };
    }
  });

  return {
    entityName: 'Entities.' + entityInfo.entityName,
    modelName: 'Models.' + modelInfo.modelName,
    mapperName,
    toPersistenceHandlers,
    toDomainHandlers,
  };
}

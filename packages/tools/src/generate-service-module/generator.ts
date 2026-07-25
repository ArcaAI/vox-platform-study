import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import { Logger } from '../utils/Logger';

const logger = new Logger('generate-service-module');

export interface ServiceModuleGeneratorOptions {
  outputPath: string;
  name: string;
  serviceGroupFolderPath?: string;
  overwrite?: boolean;
}

interface ServiceModuleTemplateData {
  // Service names
  className: string;
  propertyName: string;
  fileName: string;
  constantName: string;
  // Service interfaces
  interfaceName: string;
  serviceModuleName: string;
  serviceFileName: string;
  dtoMapperName: string;
  dtoMapperFileName: string;
  // DTO names
  createDtoName: string;
  updateDtoName: string;
  responseDtoName: string;
  paginatedResponseDtoName: string;
  // Entity related
  entityName: string;
  factoryName: string;
  factoryFuncName: string;
  repositoryName: string;
  repositoryPropertyName: string;
  // Other
  resourceTypeName: string;
  name: string;
  individualEntityPropertyName: string;
  multipleEntitiesPropertyName: string;
}

// Register Handlebars helpers
Handlebars.registerHelper('lowerFirst', function (str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
});

export async function generateServiceModule(options: ServiceModuleGeneratorOptions): Promise<void> {
  const { outputPath, name, serviceGroupFolderPath, overwrite = false } = options;

  // Generate name variations
  const nameVariations = {
    name,
    className: '',
    propertyName: '',
    fileName: '',
    constantName: '',
  };

  // Apply the name transformations
  nameVariations.className = name.charAt(0).toUpperCase() + name.slice(1);
  nameVariations.propertyName = name.charAt(0).toLowerCase() + name.slice(1);
  nameVariations.fileName = name.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
  nameVariations.constantName = name.toUpperCase();

  // Construct the service path
  const servicePath = serviceGroupFolderPath
    ? path.join(outputPath, serviceGroupFolderPath, nameVariations.propertyName)
    : path.join(outputPath, nameVariations.propertyName);

  // Create directories if they don't exist
  if (!fs.existsSync(servicePath)) {
    fs.mkdirSync(servicePath, { recursive: true });
  }

  // Create dto directory
  const dtoPath = path.join(servicePath, 'dto');
  if (!fs.existsSync(dtoPath)) {
    fs.mkdirSync(dtoPath, { recursive: true });
  }

  // Generate template data
  const templateData = generateTemplateData(nameVariations);

  logger.info('Generating service module with options:', templateData);

  // Generate files
  await generateFiles(servicePath, templateData, overwrite);

  logger.info(`Service module ${templateData.className} generated successfully!`);
}

function generateTemplateData(nameVariations: {
  name: string;
  className: string;
  propertyName: string;
  fileName: string;
  constantName: string;
}): ServiceModuleTemplateData {
  const { className, propertyName, fileName, constantName, name } = nameVariations;

  return {
    className,
    propertyName,
    fileName,
    constantName,
    // Service interfaces
    interfaceName: `I${className}Service`,
    serviceModuleName: `${className}ServiceModule`,
    serviceFileName: `${fileName}.service`,
    dtoMapperName: `${className}DtoMapper`,
    dtoMapperFileName: `${fileName}.dto.mapper`,
    // DTO names
    createDtoName: `Create${className}Request`,
    updateDtoName: `Update${className}Request`,
    responseDtoName: `${className}Response`,
    paginatedResponseDtoName: `Paginated${className}Response`,
    // Entity related
    entityName: `${className}Entity`,
    factoryName: `${className}Factory`,
    factoryFuncName: `Create${className}`,
    repositoryName: `${className}Repository`,
    repositoryPropertyName: `${propertyName}Repository`,
    // Other
    resourceTypeName: className,
    name,
    individualEntityPropertyName: propertyName,
    multipleEntitiesPropertyName: `${propertyName}s`,
  };
}

async function generateFiles(servicePath: string, templateData: ServiceModuleTemplateData, overwrite: boolean): Promise<void> {
  const templatesDir = path.join(__dirname, 'templates');

  // Interface file
  await generateFile(path.join(templatesDir, 'interface.hbs'), path.join(servicePath, `${templateData.interfaceName}.ts`), templateData, overwrite);

  // Service file
  await generateFile(path.join(templatesDir, 'service.hbs'), path.join(servicePath, `${templateData.serviceFileName}.ts`), templateData, overwrite);

  // Service module file
  await generateFile(
    path.join(templatesDir, 'module.hbs'),
    path.join(servicePath, `${templateData.fileName}.service.module.ts`),
    templateData,
    overwrite,
  );

  // DTO mapper file
  await generateFile(
    path.join(templatesDir, 'dto-mapper.hbs'),
    path.join(servicePath, `${templateData.dtoMapperFileName}.ts`),
    templateData,
    overwrite,
  );

  // Index file
  await generateFile(path.join(templatesDir, 'index.hbs'), path.join(servicePath, 'index.ts'), templateData, overwrite);

  // DTO files
  const dtoPath = path.join(servicePath, 'dto');

  // Create DTO
  await generateFile(
    path.join(templatesDir, 'dto', 'create-dto.hbs'),
    path.join(dtoPath, `${templateData.fileName}-create.request.ts`),
    templateData,
    overwrite,
  );

  // Update DTO
  await generateFile(
    path.join(templatesDir, 'dto', 'update-dto.hbs'),
    path.join(dtoPath, `${templateData.fileName}-update.request.ts`),
    templateData,
    overwrite,
  );

  // Response DTO
  await generateFile(
    path.join(templatesDir, 'dto', 'response-dto.hbs'),
    path.join(dtoPath, `${templateData.fileName}.response.ts`),
    templateData,
    overwrite,
  );

  // Paginated Response DTO
  await generateFile(
    path.join(templatesDir, 'dto', 'paginated-response-dto.hbs'),
    path.join(dtoPath, `${templateData.fileName}-paginated.response.ts`),
    templateData,
    overwrite,
  );

  // DTO index file
  await generateFile(path.join(templatesDir, 'dto', 'index.hbs'), path.join(dtoPath, 'index.ts'), templateData, overwrite);
}

async function generateFile(templatePath: string, outputPath: string, data: ServiceModuleTemplateData, overwrite: boolean): Promise<void> {
  // Check if file exists and overwrite is false
  if (fs.existsSync(outputPath) && !overwrite) {
    logger.info(`Skipping existing file: ${outputPath}`);
    return;
  }

  try {
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const template = Handlebars.compile(templateContent);
    const content = template(data);

    fs.writeFileSync(outputPath, content, 'utf-8');
    logger.info(`Generated file: ${outputPath}`);
  } catch (error) {
    logger.error(`Error generating file ${outputPath}:`, error);
    throw error;
  }
}

export default generateServiceModule;

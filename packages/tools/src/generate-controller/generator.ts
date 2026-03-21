import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import { names } from '../utils/names';
import { Logger } from '../utils/Logger';

const logger = new Logger('generate-controller');

export interface ControllerGeneratorOptions {
    outputPath: string;
    name: string;
    interfaceName: string;
    apiTag: string;
    overwrite?: boolean;
}

interface ControllerTemplateData {
    // Controller names
    controllerName: string;
    controllerPropertyName: string;
    controllerFileName: string;
    controllerModuleName: string;
    controllerModuleFileName: string;
    // Service names
    serviceModuleName: string;
    servicePropertyName: string;
    interfaceName: string;
    // DTO names
    createDtoName: string;
    updateDtoName: string;
    responseName: string;
    paginatedResponseName: string;
    dtoMapperName: string;
    // API information
    apiTag: string;
    // Resource names
    resourceName: string;
    resourceNamePlural: string;
}

// Register Handlebars helpers
Handlebars.registerHelper('lowerFirst', function(str) {
    return str.charAt(0).toLowerCase() + str.slice(1);
});

export async function generateController(options: ControllerGeneratorOptions): Promise<void> {
    const { outputPath, name, interfaceName, apiTag, overwrite = false } = options;

    // Generate name variations
    const nameVariations = {
        name,
        className: '',
        propertyName: '',
        fileName: '',
        constantName: ''
    };

    // Apply the name transformations
    nameVariations.className = name.charAt(0).toUpperCase() + name.slice(1);
    nameVariations.propertyName = name.charAt(0).toLowerCase() + name.slice(1);
    nameVariations.fileName = name.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
    nameVariations.constantName = name.toUpperCase();

    // Construct the controller path
    const controllerPath = path.join(outputPath, nameVariations.fileName);

    // Create directories if they don't exist
    if (!fs.existsSync(controllerPath)) {
        fs.mkdirSync(controllerPath, { recursive: true });
    }

    // Generate template data
    const templateData = generateTemplateData(nameVariations, interfaceName, apiTag);

    logger.info('Generating controller with options:', templateData);

    // Generate files
    await generateFiles(controllerPath, templateData, overwrite);

    logger.info(`Controller ${templateData.controllerName} generated successfully!`);
}

function generateTemplateData(
    nameVariations: {
        name: string;
        className: string;
        propertyName: string;
        fileName: string;
        constantName: string;
    },
    interfaceName: string,
    apiTag: string
): ControllerTemplateData {
    const { className, propertyName, fileName } = nameVariations;

    // Extract the base name from the service interface name
    // (e.g., IUserService -> User)
    const serviceName = interfaceName.replace(/^I/, '').replace(/Service$/, '');

    return {
        // Controller names
        controllerName: `${className}Controller`,
        controllerPropertyName: `${propertyName}Controller`,
        controllerFileName: `${fileName}.controller`,
        controllerModuleName: `${className}ControllerModule`,
        controllerModuleFileName: `${fileName}.controller.module`,
        // Service names
        serviceModuleName: `${serviceName}ServiceModule`,
        servicePropertyName: `${propertyName}Service`,
        interfaceName,
        // DTO names
        createDtoName: `Create${serviceName}Request`,
        updateDtoName: `Update${serviceName}Request`,
        responseName: `${serviceName}Response`,
        paginatedResponseName: `Paginated${serviceName}Response`,
        dtoMapperName: `${serviceName}DtoMapper`,
        // API information
        apiTag,
        // Resource names
        resourceName: propertyName,
        resourceNamePlural: `${propertyName}s`
    };
}

async function generateFiles(
    controllerPath: string,
    templateData: ControllerTemplateData,
    overwrite: boolean
): Promise<void> {
    const templatesDir = path.join(__dirname, 'templates');

    // Controller file
    await generateFile(
        path.join(templatesDir, 'controller.hbs'),
        path.join(controllerPath, `${templateData.controllerFileName}.ts`),
        templateData,
        overwrite
    );

    // Controller module file
    await generateFile(
        path.join(templatesDir, 'controller-module.hbs'),
        path.join(controllerPath, `${templateData.controllerModuleFileName}.ts`),
        templateData,
        overwrite
    );

    // Index file
    await generateFile(
        path.join(templatesDir, 'index.hbs'),
        path.join(controllerPath, 'index.ts'),
        templateData,
        overwrite
    );
}

async function generateFile(
    templatePath: string,
    outputPath: string,
    data: ControllerTemplateData,
    overwrite: boolean
): Promise<void> {
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

export default generateController;
import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { DMMF } from '@prisma/generator-helper';
import inquirer from 'inquirer';
import { DomainFolder, EntityMetadata, GenerateEntityOptions, SelectedItem } from './types';
import { getPrismaDMMF } from '../utils/getPrismaDMMF';
import { names } from '../utils/names';
import { checkDirectory } from '../utils/checkDirectory';
import { Logger } from '../utils/Logger';
import { getPnpmWorkspaceNodeModulesPath } from '../utils/getNodeModulesPath';
// Load environment variables using centralized utility
import '../utils/loadEnv';

const logger = new Logger('Generate Data Entity');

export async function setupCommandLineOptions(): Promise<GenerateEntityOptions> {
    program
        .name('generate-data-entity')
        .description('Generate TypeScript data entity files')
        .option('-o, --output-path <path>', 'Output directory for generated files')
        .option('--overwrite <boolean>', 'Overwrite existing files', (value) => {
            if (value !== 'true' && value !== 'false') {
                throw new Error('overwrite option must be either "true" or "false"');
            }
            return value === 'true';
        })
        .parse(process.argv);

    const options = program.opts<GenerateEntityOptions>();
    const shouldOverwrite = options.overwrite ?? false;

    const outputBasePath = options.outputPath || path.resolve(process.env.OUTPUT_PATH || '..');
    const outputPath = path.resolve(outputBasePath, 'domains/src/entities', 'generated');

    return {
        outputPath,
        overwrite: shouldOverwrite
    };
}

function discoverDomainFolders(prismaPath: string): DomainFolder[] {
    return fs.readdirSync(prismaPath)
        .filter(folder => folder.match(/^(.+)(-prisma-client)$/))
        .map(folder => {
            const domainName = folder.replace(/(.+)(-prisma-client)$/, '$1');
            return {
                name: domainName,
                value: folder,
                folderPath: path.resolve(prismaPath, folder),
                module: `.prisma/${folder}`
            };
        });
}

async function selectDomains(domainFolders: DomainFolder[]): Promise<DomainFolder[]> {
    const { selectedDomains } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedDomains',
            message: 'Select domains to generate models for:',
            choices: [
                { name: 'All domains', value: 'all' },
                ...domainFolders.map(domain => ({ name: domain.name, value: domain.value }))
            ]
        }
    ]);

    return selectedDomains === 'all'
        ? domainFolders
        : domainFolders.filter(domain => domain.value === selectedDomains);
}

async function selectItemsForDomain(models: any[], domain: DomainFolder, isAllDomains: boolean): Promise<SelectedItem[]> {
    if (isAllDomains) {
        return [
            ...models.map(model => ({ type: 'model' as const, name: model.name, data: model })),
        ];
    }

    const { selectedItem } = await inquirer.prompt<{ selectedItem: SelectedItem[] }>([
        {
            type: 'checkbox',
            name: 'selectedItem',
            message: `Select entities to generate for domain ${domain.name}:`,
            choices: [
                new inquirer.Separator('--- Entity ---'),
                ...models.map(model => ({ name: model.name, value: { type: 'model', name: model.name, data: model } })),
            ],
            pageSize: 20
        }
    ]);

    return selectedItem;
}

function getBaseClassName(fields: DMMF.Field[]): {
    baseClassName: string;
    baseClassPropsName: string;
    ignoreTenantId: boolean;
} {
    const ignoreTenantId = !fields.some((f) => f.name === 'tenantId');
    if (fields.some((f) => f.name === 'tags')) {
        return {
            baseClassName: 'BaseTaggedEntity',
            baseClassPropsName: 'IBaseTaggedEntity',
            ignoreTenantId
        };
    }
    if (fields.some((f) => f.name === 'tenantId')) {
        return {
            baseClassName: 'BaseTenantEntity',
            baseClassPropsName: 'IBaseTenantEntity',
            ignoreTenantId
        };
    }
    return {
        baseClassName: 'BaseEntity',
        baseClassPropsName: 'IBaseEntity',
        ignoreTenantId
    };
}

function analyzeModelFields(
    fields: DMMF.Field[],
    baseType: ReturnType<typeof getBaseClassName>
): {
    properties: { name: string; type: string; isRelationship: boolean; isRequired: boolean }[];
    hasDecimal: boolean;
} {
    const baseFields = {
        BaseEntity: [
            'id',
            'metaData',
            'version',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt',
            'resourceStatus',
            'resourceStatusUpdatedAt',
            'resourceStatusUpdatedBy'
        ],
        BaseTenantEntity: [
            'id',
            'metaData',
            'version',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt',
            'resourceStatus',
            'resourceStatusUpdatedAt',
            'resourceStatusUpdatedBy',
            'tenantId'
        ],
        BaseTaggedEntity: [
            'id',
            'metaData',
            'version',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt',
            'resourceStatus',
            'resourceStatusUpdatedAt',
            'resourceStatusUpdatedBy',
            'tags',
            'tenantId'
        ]
    };

    const baseFieldsToOmit = baseFields[baseType.baseClassName as keyof typeof baseFields] || [];
    let hasDecimal = false;

    const properties = fields
        .filter((field) => !baseFieldsToOmit.includes(field.name))
        .map((field) => {
            if (field.type === 'Decimal') hasDecimal = true;

            const typeMap: Record<string, string> = {
                String: 'string',
                Int: 'number',
                Float: 'number',
                Boolean: 'boolean',
                DateTime: 'Date',
                Decimal: 'Decimal',
                Json: 'JsonValue'
            };

            const isRelationship = field.kind === 'object';
            let type = typeMap[field.type] || field.type;

            if (field.kind === 'enum') {
                type = `Enums.${field.type}`;
            } else if (isRelationship) {
                type = `Entities.${field.type}Entity`;
            }

            if (field.isList) {
                type = `${type}[]`;
            }

            if (!field.isRequired || isRelationship) {
                type = `${type} | null`;
            }

            return {
                name: field.name,
                type,
                isRelationship,
                isRequired: field.isList && field.isRequired ? false : field.isRequired
            };
        });

    return { properties, hasDecimal };
}

function generateEntityFile(model: DMMF.Model, domainName: string, outputPath: string, template: HandlebarsTemplateDelegate, shouldOverwrite: boolean) {
    const baseType = getBaseClassName([...model.fields]);
    const { properties, hasDecimal } = analyzeModelFields([...model.fields], baseType);
    const modelNames = names(model.name);

    const metadata: EntityMetadata = {
        entityName: `${modelNames.className}Entity`,
        entityPropsName: `I${modelNames.className}Entity`,
        ...baseType,
        properties,
        hasDecimal
    };

    // Create domain-specific folder
    const domainOutputPath = path.resolve(outputPath, domainName);
    if (!fs.existsSync(domainOutputPath)) {
        fs.mkdirSync(domainOutputPath, { recursive: true });
    }

    const entityContent = template(metadata);
    const filePath = path.resolve(domainOutputPath, `${modelNames.entityName}.ts`);

    if (fs.existsSync(filePath) && !shouldOverwrite) {
        logger.info(`Skipping existing entity file: ${filePath}`);
        return;
    }

    fs.writeFileSync(filePath, entityContent, 'utf-8');
    logger.info(`${fs.existsSync(filePath) ? 'Overwrote' : 'Generated'} entity file: ${modelNames.entityName}.ts`);
}

function generateDomainIndexFile(domainName: string, outputPath: string, domainModels: string[]) {
    const domainOutputPath = path.resolve(outputPath, domainName);
    if (!fs.existsSync(domainOutputPath)) {
        fs.mkdirSync(domainOutputPath, { recursive: true });
    }

    const imports = domainModels
        .map(model => {
            const modelNames = names(model);
            return `export * from './${modelNames.entityName}';`;
        })
        .join('\n');

    const indexPath = path.resolve(domainOutputPath, 'index.ts');
    // Always overwrite the index file to prevent duplication
    fs.writeFileSync(indexPath, imports + '\n', 'utf-8');
    logger.info(`Generated domain index file: ${indexPath}`);
}

function generateRootIndexFile(outputPath: string, selectedDomains: DomainFolder[]) {
    const imports = selectedDomains
        .map(domain => `export * from './${domain.name}';`)
        .join('\n');

    const indexPath = path.resolve(outputPath, 'index.ts');
    // Always overwrite the root index file to prevent duplication
    fs.writeFileSync(indexPath, imports + '\n', 'utf-8');
    logger.info(`Generated root index file: ${indexPath}`);
}

async function processDomain(
    domain: DomainFolder,
    options: GenerateEntityOptions,
    entityTemplate: HandlebarsTemplateDelegate,
    isAllDomains: boolean
): Promise<SelectedItem[] | undefined> {
    logger.info(`Processing domain: ${domain.name}`);

    try {
        const dmmf = await getPrismaDMMF(domain.folderPath);
        const { models } = dmmf.datamodel;

        if (!models.length) {
            logger.warn(`No models found in domain ${domain.name}. Skipping.`);
            return;
        }

        const selectedItems = await selectItemsForDomain(models, domain, isAllDomains);

        // Track model names for this domain
        const domainModelNames: string[] = [];

        for (const item of selectedItems) {
            if (item.type === 'model') {
                generateEntityFile(item.data, domain.name, options.outputPath, entityTemplate, options.overwrite);
                domainModelNames.push(item.name);
            }
        }

        // Generate domain-specific index file
        if (domainModelNames.length > 0) {
            generateDomainIndexFile(domain.name, options.outputPath, domainModelNames);
        }

        return selectedItems;
    } catch (error) {
        logger.error(`Error processing domain ${domain.name}: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
}

async function main() {
    try {
        const options = await setupCommandLineOptions();

        // Ensure the output directory exists
        if (!fs.existsSync(options.outputPath)) {
            fs.mkdirSync(options.outputPath, { recursive: true });
        }

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

        // Load the Handlebars template
        const templatePath = path.resolve(__dirname, 'templates', 'entity.hbs');
        if (!fs.existsSync(templatePath)) {
            logger.error(`Template file not found: ${templatePath}`);
            process.exit(1);
        }

        const templateSource = fs.readFileSync(templatePath, 'utf-8');
        const entityTemplate = Handlebars.compile(templateSource);

        const isAllDomains = selectedDomains.length === domainFolders.length;
        const allSelectedItems: SelectedItem[] = [];

        for (const domain of selectedDomains) {
            const domainItems = await processDomain(domain, options, entityTemplate, isAllDomains);
            if (domainItems) {
                allSelectedItems.push(...domainItems);
            }
        }

        // Generate root index file that exports from all domain folders
        if (selectedDomains.length > 0) {
            generateRootIndexFile(options.outputPath, selectedDomains);
        }

        logger.info('Entity generation completed successfully.');
    } catch (error) {
        logger.error(`Error generating entities: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// Run the main function if this module is executed directly
if (require.main === module) {
    main().catch(error => {
        logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}

#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { program } from 'commander';
import inquirer from 'inquirer';
import Handlebars from 'handlebars';
import { SelectedItem, DomainFolder, CommandLineOptions, ProcessingOptions } from './types';
import {
    Logger,
    names,
    getPnpmWorkspaceNodeModulesPath,
    discoverPrismaDomains,
    getDMMFForDomain,
    formatWithPrettier,
    reportDrift as reportSharedDrift,
} from '../utils';
// Load environment variables using centralized utility
import '../utils/loadEnv';

// Initialize logger for this file
const logger = new Logger('Generate Data Model');

// Define the main function to run the CLI utility
async function main() {
    try {
        const options = await setupCommandLineOptions();

        const workspaceRoot = path.dirname(getPnpmWorkspaceNodeModulesPath());
        const domainFolders: DomainFolder[] = await discoverPrismaDomains(workspaceRoot);
        if (domainFolders.length === 0) {
            logger.error('No Prisma schema packages found.');
            logger.error('Expected a workspace package whose package.json declares a "prisma.schema" path.');
            process.exit(1);
        }

        // In check mode nothing is written, so the output directories are never touched.
        if (options.mode === 'write') {
            setupDirectories(options.outputModelsPath, options.enumsOutputPath);
        }

        const selectedDomains = await selectDomains(domainFolders, options);
        const modelTemplateSource = fs.readFileSync(
            path.resolve(__dirname, 'templates', 'model.hbs'),
            'utf-8'
        );
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
        await generateRootIndexFiles(options, selectedDomains, allSelectedItems);

        if (options.mode === 'check') {
            const exitCode = reportSharedDrift(
                options.outputs,
                workspaceRoot,
                logger,
                'Regenerate with "pnpm --filter @arcaai/tools generate-data-model:all" once manual edits are reconciled.'
            );
            process.exit(exitCode);
        }

        logger.info('Data model generation completed successfully.');

    } catch (error) {
        logger.error(`Error generating data models: ${errorMessage(error)}`);
        process.exit(1);
    }
}

async function setupCommandLineOptions(): Promise<ProcessingOptions> {
    program
        .name('generate-data-model')
        .description('Generate TypeScript data model and enum files from the Prisma schema')
        .option('-o, --output-path <path>', 'Output directory for generated files')
        .option('--domain <name>', 'Domain to generate ("all" or a domain name). Skips the domain prompt.')
        .option('-y, --yes', 'Non-interactive: select all domains and all items without prompting')
        .option('--ci', 'Alias for --yes (non-interactive, selects everything)')
        .option(
            '--check',
            'Dry-run: report whether regeneration would change committed files. Writes nothing and exits non-zero when drift is found.'
        )
        .option('--overwrite <boolean>', 'Whether to overwrite existing files (true/false)', (value) => {
            if (value !== 'true' && value !== 'false') {
                throw new Error('overwrite option must be either "true" or "false"');
            }
            return value === 'true';
        })
        .parse(process.argv);

    const options = program.opts<CommandLineOptions>();
    const check = options.check ?? false;
    const shouldOverwrite = options.overwrite ?? false;

    // Non-interactive when explicitly asked (--yes/--ci/--check) or when stdin is not a
    // TTY (pipes / CI / pre-commit). Otherwise keep the original interactive prompts.
    const nonInteractive = Boolean(options.yes) || Boolean(options.ci) || check || !process.stdin.isTTY;
    const interactive = !nonInteractive;

    const outputBasePath = options.outputPath || path.resolve(process.env.OUTPUT_PATH || '..');
    const outputModelsPath = path.resolve(outputBasePath, 'domains/src/models', 'generated');
    const enumsOutputPath = path.resolve(outputBasePath, 'domains/src/enums', 'generated');

    return {
        outputModelsPath,
        enumsOutputPath,
        // In check mode we always compute the full would-be output, regardless of overwrite.
        shouldOverwrite: check ? true : shouldOverwrite,
        mode: check ? 'check' : 'write',
        interactive,
        selectedDomain: options.domain,
        outputs: new Map<string, string>()
    };
}

function setupDirectories(outputModelsPath: string, enumsOutputPath: string): void {
    if (!fs.existsSync(outputModelsPath)) {
        fs.mkdirSync(outputModelsPath, { recursive: true });
    }

    if (!fs.existsSync(enumsOutputPath)) {
        fs.mkdirSync(enumsOutputPath, { recursive: true });
    }
}

async function selectDomains(domainFolders: DomainFolder[], options: ProcessingOptions): Promise<DomainFolder[]> {
    // Explicit --domain wins and skips the prompt.
    if (options.selectedDomain) {
        if (options.selectedDomain === 'all') {
            return domainFolders;
        }
        const matches = domainFolders.filter(
            (domain) => domain.name === options.selectedDomain || domain.value === options.selectedDomain
        );
        if (matches.length === 0) {
            const available = domainFolders.map((domain) => domain.name).join(', ');
            throw new Error(`Unknown domain "${options.selectedDomain}". Available: ${available} (or "all").`);
        }
        return matches;
    }

    // Non-interactive default: every domain.
    if (!options.interactive) {
        return domainFolders;
    }

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

async function selectItemsForDomain(
    models: any[],
    enums: any[],
    domain: DomainFolder,
    isAllDomains: boolean,
    options: ProcessingOptions
): Promise<SelectedItem[]> {
    // Generated output follows the schema/DMMF declaration order (the canonical
    // ordering source-of-truth) so it is deterministic and matches the schema.
    const allItems = (): SelectedItem[] => [
        ...models.map(model => ({ type: 'model' as const, name: model.name, data: model })),
        ...enums.map(enumItem => ({ type: 'enum' as const, name: enumItem.name, data: enumItem }))
    ];

    // Non-interactive (or "all domains") selects everything without prompting.
    if (!options.interactive || isAllDomains) {
        return allItems();
    }

    const { selectedItems } = await inquirer.prompt<{ selectedItems: SelectedItem[] }>([
        {
            type: 'checkbox',
            name: 'selectedItems',
            message: `Select models and enums to generate for domain ${domain.name}:`,
            choices: [
                new inquirer.Separator('--- Models ---'),
                ...sortByName(models).map(model => ({ name: model.name, value: { type: 'model', name: model.name, data: model } })),
                new inquirer.Separator('--- Enums ---'),
                ...sortByName(enums).map(enumItem => ({ name: enumItem.name, value: { type: 'enum', name: enumItem.name, data: enumItem } }))
            ],
            pageSize: 20
        }
    ]);

    return selectedItems;
}

async function generateEnumFile(
    enumItem: SelectedItem,
    enumsOutputPath: string,
    modelTemplate: HandlebarsTemplateDelegate,
    options: ProcessingOptions
): Promise<void> {
    const className = names(enumItem.data.name).className;
    const enumFilePath = path.resolve(enumsOutputPath, `${className}.ts`);
    const preservation = extractPreservation(enumFilePath);
    // Enum value order is preserved from the schema (DMMF declaration order); it is
    // deterministic and semantically meaningful (e.g. Postgres enum sort order), so we
    // never re-sort it. Any hand-authored per-value `//` comment is round-tripped.
    const enumValues = enumItem.data.values.map((value: any) => ({
        name: value.name,
        comment: preservation.enumValueComments.get(value.name)
    }));

    const enumFileContent = modelTemplate({
        className,
        enumValues,
        hasDecimal: false,
        baseModel: '',
        classDoc: null,
        scalarFields: [],
        relationFields: []
    });

    await emit(options, enumFilePath, enumFileContent, options.shouldOverwrite);
}

async function generateModelFile(
    modelItem: SelectedItem,
    domainOutputPath: string,
    modelTemplate: HandlebarsTemplateDelegate,
    options: ProcessingOptions
): Promise<void> {
    const model = modelItem.data;
    const className = names(model.name).className;

    let baseModel = 'BaseDataModel';
    if (model.fields.find((f: any) => /tenantId/.test(f.name))) {
        baseModel = 'BaseTenantDataModel';
    }
    // Only the singular append-only `AuditLog` WORM table inlines its base fields
    // (no base class). Other "*Audit*" models (e.g. HarnessAuditEvent) are
    // standard tenant models that extend BaseTenantDataModel.
    if (model.name === 'AuditLog') {
        baseModel = '';
    }

    const modelFilePath = path.resolve(domainOutputPath, `${className}Model.ts`);
    const preservation = extractPreservation(modelFilePath);

    const { scalarFields, hasDecimal } = composeScalarEnumFields(model.fields, baseModel, preservation);
    const relationFields = composeRelationFields(model.fields);

    const modelFileContent = modelTemplate({
        className,
        enumValues: [],
        hasDecimal,
        baseModel,
        classDoc: preservation.classDoc,
        scalarFields,
        relationFields
    });

    await emit(options, modelFilePath, modelFileContent, options.shouldOverwrite);
}

async function generateDomainIndexFile(domainOutputPath: string, selectedItems: SelectedItem[], options: ProcessingOptions): Promise<void> {
    const modelItems = selectedItems.filter(item => item.type === 'model');
    if (modelItems.length === 0) return;

    // Schema-derived model files (from DMMF) ...
    const moduleNames = new Set<string>(
        modelItems.map(item => `${names(item.name).className}Model`)
    );

    // ... unioned with any `*Model.ts` already present in the folder. This keeps
    // hand-maintained ORPHAN models exported — models whose Prisma model was
    // retired (so DMMF no longer yields them) but whose TS model + entity/mapper/
    // repository stack is still wired into the application layer (e.g.
    // Permission / RolePermission after the policy-based RBAC migration).
    if (fs.existsSync(domainOutputPath)) {
        for (const file of fs.readdirSync(domainOutputPath)) {
            if (file.endsWith('Model.ts')) {
                moduleNames.add(file.slice(0, -'.ts'.length));
            }
        }
    }

    // Sorted alphabetically so the barrel is deterministic regardless of schema
    // declaration order or filesystem enumeration order.
    const modelExports = [...moduleNames]
        .sort((a, b) => a.localeCompare(b))
        .map(name => `export * from './${name}';`)
        .join('\n');

    const indexFilePath = path.resolve(domainOutputPath, 'index.ts');
    // Index files are always (re)written so they reflect the current selection.
    await emit(options, indexFilePath, modelExports, true);
}

async function generateRootIndexFiles(
    options: ProcessingOptions,
    selectedDomains: DomainFolder[],
    allSelectedItems: SelectedItem[]
): Promise<void> {
    // Generate index file for enums — exports sorted alphabetically so the barrel
    // is deterministic regardless of schema declaration order.
    const enumItems = allSelectedItems.filter(item => item.type === 'enum');
    if (enumItems.length > 0) {
        const enumExports = enumItems
            .map(item => names(item.name).className)
            .sort((a, b) => a.localeCompare(b))
            .map(name => `export * from './${name}';`)
            .join('\n');

        const enumsIndexPath = path.resolve(options.enumsOutputPath, 'index.ts');
        await emit(options, enumsIndexPath, enumExports, true);
        logger.info('Prepared index.ts file for enums folder');
    }

    // Generate index file for models/generated (one export per domain folder).
    if (selectedDomains.length > 0) {
        const domainExports = [...selectedDomains]
            .map(domain => domain.name)
            .sort((a, b) => a.localeCompare(b))
            .map(name => `export * from './${name}';`)
            .join('\n');

        const modelsIndexPath = path.resolve(options.outputModelsPath, 'index.ts');
        await emit(options, modelsIndexPath, domainExports, true);
        logger.info('Prepared index.ts file for models/generated folder');
    }
}

async function processDomain(
    domain: DomainFolder,
    options: ProcessingOptions,
    modelTemplate: HandlebarsTemplateDelegate,
    isAllDomains: boolean
): Promise<SelectedItem[] | undefined> {
    logger.info(`Processing domain: ${domain.name}`);

    try {
        const dmmf = await getDMMFForDomain(domain);
        const { models, enums } = dmmf.datamodel;

        if (!models.length && !enums.length) {
            logger.warn(`No models or enums found in domain ${domain.name}. Skipping.`);
            return;
        }

        const domainOutputPath = path.resolve(options.outputModelsPath, domain.name);
        if (options.mode === 'write' && !fs.existsSync(domainOutputPath)) {
            fs.mkdirSync(domainOutputPath, { recursive: true });
        }

        const selectedItems = await selectItemsForDomain(
            models as any[],
            enums as any[],
            domain,
            isAllDomains,
            options
        );

        for (const item of selectedItems) {
            if (item.type === 'enum') {
                await generateEnumFile(item, options.enumsOutputPath, modelTemplate, options);
            } else {
                await generateModelFile(item, domainOutputPath, modelTemplate, options);
            }
        }

        await generateDomainIndexFile(domainOutputPath, selectedItems, options);
        logger.info(`Prepared index.ts file for domain: ${domain.name}`);

        return selectedItems;

    } catch (error) {
        logger.error(`Error processing domain ${domain.name}: ${errorMessage(error)}`);
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
    fields: any[],
    baseModel: string,
    preservation: PreservedCustomizations = emptyPreservation()
): {
    scalarFields: { name: string; type: string; comment?: string; init: string }[];
    hasDecimal: boolean;
} {
    let hasDecimal = false;
    const BASE_MODEL_FIELDS: Record<string, string[]> = {
        BaseDataModel: [
            'metaData',
            'version',
            'id',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt'
        ],
        BaseTenantDataModel: [
            'metaData',
            'version',
            'id',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt',
            'tenantId'
        ]
    };

    const MAPPINGS: Record<string, string> = {
        Decimal: 'Decimal',
        Int: 'number',
        Float: 'number',
        String: 'string',
        Boolean: 'boolean',
        DateTime: 'Date',
        Json: 'JsonValue',
        // Prisma `Bytes` maps to `Uint8Array` in the Prisma 7 client types.
        Bytes: 'Uint8Array',
        // Prisma `BigInt` maps to the native `bigint` in the Prisma 7 client types.
        // Previously absent → fell back to `any`, which drifted vs the hand-corrected
        // committed models (e.g. `TenantBucket.quotaBytes`). Mapping it here makes the
        // generator emit `bigint` so the generated layer matches the schema.
        BigInt: 'bigint'
    };

    const fieldsToOmit = baseModel ? BASE_MODEL_FIELDS[baseModel] || [] : [];

    const scalarFields = fields
        .filter((field) => field.kind !== 'object')
        .filter((field) => !fieldsToOmit.includes(field.name))
        .map((field) => {
            const { name, type } = field;
            const array = field.isList ? '[]' : '';
            // Preserve any hand-authored field comment + constructor default (RHS);
            // fall back to a plain `data.<name>` assignment for new/undecorated fields.
            const comment = preservation.fieldComments.get(name);
            const init = preservation.ctorDefaults.get(name) ?? `data.${name}`;

            if (field.kind === 'enum') {
                return {
                    name,
                    type: `Enums.${type}${array} ${field.isRequired ? '' : '| null'}`,
                    comment,
                    init
                };
            }

            if (type === 'Decimal') {
                hasDecimal = true;
            }

            return {
                name,
                type: `${MAPPINGS[type] || 'any'}${array} ${field.isRequired ? '' : '| null'}`,
                comment,
                init
            };
        });

    return { scalarFields, hasDecimal };
}

/**
 * Compose relation fields for a model.
 * @param fields - The fields of the model.
 * @returns The relation fields for the model.
 */
function composeRelationFields(
    fields: any[]
): { name: string; type: string }[] {
    return fields
        .filter((field) => field.kind === 'object')
        .map((field) => {
            const { name, type } = field;
            const array = field.isList ? '[]' : '';
            return { name, type: `Models.${names(type).className}${array}` };
        });
}

/**
 * Sort DMMF items (models/enums) alphabetically by name without mutating the
 * (readonly) source array.
 */
function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Customizations preserved across regeneration from the previously-emitted file.
 *
 * The Prisma schema cannot express several behaviour-affecting hand-edits that
 * the committed `generated/` files encode:
 *   - constructor defaults (`?? []`, `?? false`, `?? Enums.X.Y`) — applied
 *     INCONSISTENTLY across models, so they are NOT derivable from a field's
 *     `@default(...)` without churning every other defaulted field.
 *   - class-level JSDoc and field-level `//` comments (DMMF only exposes `///`
 *     triple-slash docs, and the committed comments are condensed/hand-authored
 *     and differ from the schema text).
 *   - enum-value `//` comments.
 *
 * To keep `--check` green and never silently drop a behaviour-affecting edit or
 * human documentation, the generator ROUND-TRIPS these from the existing file:
 * it parses the previously-emitted output, keys each customization by field /
 * enum-value name (robust to re-ordering), and re-emits them. New fields/files
 * (no prior output) fall back to the schema-derived baseline.
 */
interface PreservedCustomizations {
    /** Class-level `/** ... *\/` JSDoc immediately preceding `export class`. */
    classDoc: string | null;
    /** Field name → contiguous `//` comment block immediately preceding it. */
    fieldComments: Map<string, string>;
    /** Field name → constructor right-hand side (e.g. `data.tags ?? []`). */
    ctorDefaults: Map<string, string>;
    /** Enum value name → contiguous `//` comment block immediately preceding it. */
    enumValueComments: Map<string, string>;
}

function emptyPreservation(): PreservedCustomizations {
    return {
        classDoc: null,
        fieldComments: new Map(),
        ctorDefaults: new Map(),
        enumValueComments: new Map(),
    };
}

/**
 * Collect the contiguous block of single-line `//` comments immediately above
 * `declIdx`, returning them left-trimmed (Prettier re-indents on emit). Stops at
 * the first blank line, decorator, or non-comment line so section headers that
 * sit above an unrelated declaration are not captured.
 */
function collectLeadingLineComments(lines: string[], declIdx: number): string | null {
    const comments: string[] = [];
    for (let i = declIdx - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('//')) {
            comments.unshift(lines[i].trimStart());
        } else {
            break;
        }
    }
    return comments.length ? comments.join('\n') : null;
}

/**
 * Parse a previously-emitted model/enum file and extract the customizations that
 * are not derivable from the Prisma schema so regeneration can re-emit them.
 * Returns empty preservation when the file does not yet exist (new artifact).
 */
function extractPreservation(filePath: string): PreservedCustomizations {
    if (!fs.existsSync(filePath)) {
        return emptyPreservation();
    }

    const result = emptyPreservation();
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Class-level JSDoc: the `/** ... */` block ending right before `export class`.
    const exportClassIdx = lines.findIndex((line) => line.startsWith('export class '));
    if (exportClassIdx > 0) {
        let end = exportClassIdx - 1;
        while (end >= 0 && lines[end].trim() === '') end--;
        if (end >= 0 && lines[end].trim().endsWith('*/')) {
            let start = end;
            while (start >= 0 && !lines[start].trim().startsWith('/**')) start--;
            if (start >= 0) {
                result.classDoc = lines
                    .slice(start, end + 1)
                    .map((line) => line.trimStart())
                    .join('\n');
            }
        }
    }

    // Field-level comments, keyed by field name (scalar declarations).
    lines.forEach((line, idx) => {
        const fieldMatch = /^\s*public\s+(\w+)\??:/.exec(line);
        if (fieldMatch) {
            const comment = collectLeadingLineComments(lines, idx);
            if (comment) result.fieldComments.set(fieldMatch[1], comment);
        }
        const enumMatch = /^\s*(\w+)\s*=\s*'[^']*',?\s*$/.exec(line);
        if (enumMatch) {
            const comment = collectLeadingLineComments(lines, idx);
            if (comment) result.enumValueComments.set(enumMatch[1], comment);
        }
    });

    // Constructor right-hand sides, keyed by field name. RHS never contains `;`.
    const ctorRegex = /this\.(\w+)\s*=\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = ctorRegex.exec(content)) !== null) {
        result.ctorDefaults.set(match[1], match[2].trim());
    }

    return result;
}

/**
 * Write a generated file, or — in check mode — record its would-be content in memory
 * instead of touching the filesystem. Content is Prettier-formatted before either.
 *
 * Prettier formatting is shared with the entity/factory generators via
 * `formatWithPrettier` (TASK-370) so the template's 4-space / blank-line layout is
 * reconciled with the committed 2-space style identically across all three tools.
 */
async function emit(options: ProcessingOptions, absolutePath: string, content: string, overwrite: boolean): Promise<void> {
    const formatted = await formatWithPrettier(absolutePath, content);

    if (options.mode === 'check') {
        options.outputs.set(absolutePath, formatted);
        return;
    }

    const existed = fs.existsSync(absolutePath);
    if (existed && !overwrite) {
        logger.info(`Skipping existing file: ${path.basename(absolutePath)}`);
        return;
    }

    fs.writeFileSync(absolutePath, formatted);
    logger.info(`${existed ? 'Overwrote' : 'Generated'} file: ${path.basename(absolutePath)}`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Execute the main function
main().catch(error => {
    logger.error(`Unhandled error: ${errorMessage(error)}`);
    process.exit(1);
});

#!/usr/bin/env node

import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import {
    Logger,
    getPnpmWorkspaceNodeModulesPath,
    reconcileBarrel,
    listModuleFiles,
    writeOutputs,
    reportDrift,
} from '../utils';
import { reportSchemaCoverage } from '../utils/schemaCoverage';
// Load environment variables using centralized utility
import '../utils/loadEnv';

const logger = new Logger('Generate Data Entity');

const ENTITY_SUFFIX = 'Entity';
// The root barrel (`entities/generated/index.ts`) ends with a single newline;
// the per-domain barrels (`entities/generated/<domain>/index.ts`) end with a
// blank line. `reconcileBarrel` infers the per-domain `\n\n` from the existing
// file, so only the root default is specified here.
const ROOT_BARREL_TRAILING = '\n';

interface EntityGeneratorOptions {
    /** Absolute path to `.../domains/src/entities/generated`. */
    generatedRoot: string;
    workspaceRoot: string;
    mode: 'write' | 'check';
}

function setupCommandLineOptions(): EntityGeneratorOptions {
    program
        .name('generate-data-entity')
        .description(
            'Preserve & reconcile the hand-curated TypeScript entity layer (TASK-370). ' +
                'Existing entities are reproduced verbatim; barrels are kept in sync.',
        )
        .option('-o, --output-path <path>', 'Base output directory (expects <base>/domains/src/entities/generated)')
        .option('--check', 'Dry-run: report drift without writing; exit 1 on drift, 0 when clean', false)
        // Accepted for parity with generate-data-model; generation is always
        // non-interactive (it preserves the committed tree, no prompts).
        .option('--yes', 'Non-interactive (no prompts; default behavior)', false)
        .option('--ci', 'Alias for --yes', false)
        .parse(process.argv);

    const options = program.opts<{ outputPath?: string; check?: boolean }>();
    const outputBasePath = options.outputPath || path.resolve(process.env.OUTPUT_PATH || '..');
    const generatedRoot = path.resolve(outputBasePath, 'domains/src/entities', 'generated');
    const workspaceRoot = path.dirname(getPnpmWorkspaceNodeModulesPath());

    return { generatedRoot, workspaceRoot, mode: options.check ? 'check' : 'write' };
}

/**
 * List the domain subdirectories (e.g. `core`) that actually hold entity files,
 * skipping `__tests__` and any empty folders. The entity layer is a hand-curated
 * projection of the Prisma schema (it deliberately omits some models and adds
 * model-less entities such as `PermissionEntity`), so the committed files on disk
 * — not the DMMF — are the source of truth for what exists.
 */
function listEntityDomains(generatedRoot: string): string[] {
    if (!fs.existsSync(generatedRoot)) {
        return [];
    }
    return fs
        .readdirSync(generatedRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
        .map((entry) => entry.name)
        .filter((domain) => listModuleFiles(path.join(generatedRoot, domain), ENTITY_SUFFIX).length > 0)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Build the full set of files a clean run would produce: every committed entity
 * reproduced verbatim (so all hand edits — business methods, `@Secret()`
 * decorators, custom imports, `Buffer` types, constructor defaults, curated field
 * order, and the inlined `PromptTemplate*` collision-fix unions — survive), plus
 * per-domain and root barrels reconciled to match the files on disk.
 */
function collectOutputs(generatedRoot: string): Map<string, string> {
    const outputs = new Map<string, string>();
    const domains = listEntityDomains(generatedRoot);

    for (const domain of domains) {
        const domainDir = path.join(generatedRoot, domain);
        const modules = listModuleFiles(domainDir, ENTITY_SUFFIX);

        for (const moduleName of modules) {
            const filePath = path.join(domainDir, `${moduleName}.ts`);
            outputs.set(filePath, fs.readFileSync(filePath, 'utf-8'));
        }

        const barrelPath = path.join(domainDir, 'index.ts');
        const existingBarrel = fs.existsSync(barrelPath) ? fs.readFileSync(barrelPath, 'utf-8') : null;
        outputs.set(barrelPath, reconcileBarrel(existingBarrel, modules));
    }

    const rootBarrelPath = path.join(generatedRoot, 'index.ts');
    const existingRootBarrel = fs.existsSync(rootBarrelPath) ? fs.readFileSync(rootBarrelPath, 'utf-8') : null;
    outputs.set(rootBarrelPath, reconcileBarrel(existingRootBarrel, domains, ROOT_BARREL_TRAILING));

    return outputs;
}

async function main(): Promise<void> {
    try {
        const options = setupCommandLineOptions();

        if (!fs.existsSync(options.generatedRoot)) {
            logger.error(`Entities directory not found: ${options.generatedRoot}`);
            process.exit(1);
        }

        const outputs = collectOutputs(options.generatedRoot);

        if (options.mode === 'check') {
            // Structural drift: verbatim files reproduced + barrels in sync.
            const structuralExit = reportDrift(
                outputs,
                options.workspaceRoot,
                logger,
                'Regenerate with "pnpm --filter @arcaai/tools generate-data-entity" once the entity files/barrels are reconciled.',
            );
            // Content-aware drift: every persisted model column is surfaced by the
            // (curated) entity layer.
            const coverageExit = await reportSchemaCoverage({
                layer: 'entity',
                generatedRoot: options.generatedRoot,
                workspaceRoot: options.workspaceRoot,
                logger,
            });
            process.exit(structuralExit === 0 && coverageExit === 0 ? 0 : 1);
        }

        writeOutputs(outputs, logger);
        logger.info('Entity generation completed successfully.');
    } catch (error) {
        logger.error(`Error generating entities: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// Run the main function if this module is executed directly
if (require.main === module) {
    void main();
}

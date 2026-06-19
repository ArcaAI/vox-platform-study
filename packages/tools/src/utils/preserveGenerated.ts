import fs from 'fs';
import path from 'path';
import * as prettier from 'prettier';
import Logger from './Logger';

/**
 * Shared "hand-edit preservation" plumbing for the `generate-data-model`,
 * `generate-data-entity` and `generate-factory` generators (TASK-368 / TASK-370).
 *
 * The committed `domains/src/**\/generated` trees are the source-of-truth: they
 * carry hand-curated content (business methods, `@Secret()` decorators, custom
 * imports, `Buffer` types, constructor defaults, curated field order, the
 * `PromptTemplate*`/`PolicyScope` collision fix, …) that the Prisma schema can
 * not express. These helpers let every generator (a) format brand-new output
 * with the repo's Prettier config, (b) reconcile a barrel without churning its
 * committed order, and (c) report drift in `--check` mode with a single exit
 * code, so a fresh re-run reproduces the committed files byte-identically.
 */

// Resolve the repo Prettier config once. Resolved from THIS file (always inside
// the repo) so the root `.prettierrc.js` is used regardless of the output path
// (e.g. when generating into a throwaway dir via `-o /tmp`).
let prettierConfig: Awaited<ReturnType<typeof prettier.resolveConfig>> | undefined;

/**
 * Format generated TypeScript with the repo's Prettier config so freshly
 * generated (not yet hand-curated) output matches the committed 2-space style
 * and is idempotent (output === prettier(output)).
 */
export async function formatWithPrettier(absolutePath: string, content: string): Promise<string> {
    if (prettierConfig === undefined) {
        prettierConfig = await prettier.resolveConfig(__filename);
    }
    return prettier.format(content, { ...prettierConfig, filepath: absolutePath, parser: 'typescript' });
}

/**
 * Parse the `export * from './X';` module names out of an existing barrel file,
 * in their committed order. Lines that are not re-exports are ignored.
 */
export function parseBarrelModules(content: string): string[] {
    const modules: string[] = [];
    const re = /export \* from '\.\/([^']+)';/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        modules.push(match[1]);
    }
    return modules;
}

/**
 * Reconcile a barrel (`index.ts`) against the set of modules that should be
 * exported, WITHOUT churning the committed order.
 *
 * - Existing exports are kept in their committed order (as long as the module is
 *   still desired) — the committed entity/factory barrels are hand-ordered and
 *   not reproducible by a plain sort, so order is preserved rather than derived.
 * - Modules not yet exported are appended (alphabetically) so newly scaffolded
 *   artifacts still get wired in.
 * - When the desired set already matches the committed barrel exactly, the
 *   existing content is returned verbatim so a clean re-run is byte-identical
 *   (this also preserves the committed trailing-whitespace style).
 *
 * @param trailing Trailing string to use when (re)building a changed barrel.
 */
export function reconcileBarrel(
    existingContent: string | null,
    desiredModules: string[],
    trailing = '\n',
): string {
    const existing = existingContent ? parseBarrelModules(existingContent) : [];
    const desired = new Set(desiredModules);

    const kept = existing.filter((module) => desired.has(module));
    const appended = desiredModules
        .filter((module) => !kept.includes(module))
        .sort((a, b) => a.localeCompare(b));
    const finalModules = [...kept, ...appended];

    const unchanged =
        existingContent !== null &&
        finalModules.length === existing.length &&
        finalModules.every((module, index) => module === existing[index]);

    if (unchanged) {
        return existingContent as string;
    }

    const effectiveTrailing = existingContent?.endsWith('\n\n') ? '\n\n' : trailing;
    return finalModules.map((module) => `export * from './${module}';`).join('\n') + effectiveTrailing;
}

/**
 * List the generated module names under a directory (e.g. all `*Entity.ts` →
 * `['AiModelEntity', …]`), excluding the barrel and any test files. The
 * `__tests__` directory is skipped because directories are not enumerated here.
 */
export function listModuleFiles(directory: string, suffix: string): string[] {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs
        .readdirSync(directory)
        .filter((file) => file.endsWith(`${suffix}.ts`) && !file.endsWith('.test.ts'))
        .map((file) => file.slice(0, -'.ts'.length))
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Write the collected outputs to disk (skipping files whose content is already
 * identical so unchanged files are never rewritten).
 */
export function writeOutputs(outputs: Map<string, string>, logger: Logger): void {
    for (const [absolutePath, content] of outputs) {
        const existed = fs.existsSync(absolutePath);
        if (existed && fs.readFileSync(absolutePath, 'utf-8') === content) {
            continue;
        }
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
        logger.info(`${existed ? 'Overwrote' : 'Generated'} file: ${path.basename(absolutePath)}`);
    }
}

/**
 * Compare the in-memory generated output against the committed files and report
 * drift. Returns a process exit code: 0 when clean, 1 when a re-run would change
 * or create anything.
 */
export function reportDrift(
    outputs: Map<string, string>,
    workspaceRoot: string,
    logger: Logger,
    regenHint: string,
): number {
    const changed: string[] = [];
    const created: string[] = [];

    for (const [absolutePath, content] of outputs) {
        if (!fs.existsSync(absolutePath)) {
            created.push(absolutePath);
        } else if (fs.readFileSync(absolutePath, 'utf-8') !== content) {
            changed.push(absolutePath);
        }
    }

    const rel = (file: string) => path.relative(workspaceRoot, file);

    if (changed.length === 0 && created.length === 0) {
        logger.info(`check: no drift — ${outputs.size} generated file(s) match the committed files.`);
        return 0;
    }

    logger.warn(
        `check: drift detected — ${changed.length} file(s) would change, ${created.length} new file(s) would be created.`,
    );
    for (const file of changed.sort()) {
        logger.warn(`  would change: ${rel(file)}`);
    }
    for (const file of created.sort()) {
        logger.warn(`  would create: ${rel(file)}`);
    }
    logger.warn(regenHint);
    return 1;
}

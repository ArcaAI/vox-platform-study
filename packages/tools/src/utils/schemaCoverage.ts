import path from 'path';
import fs from 'fs';
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import Logger from './Logger';
import { DMMF } from './getPrismaDMMF';
import { discoverPrismaDomains, getDMMFForDomain } from './prismaSchema';

/**
 * ============================================================================
 * TASK-370 — Content-aware schema-coverage check (curated-projection aware)
 * ============================================================================
 *
 * The entity (`packages/domains/src/entities/generated`) and factory
 * (`.../factories/generated`) layers are NOT a mechanical 1:1 mirror of the
 * Prisma schema — they are a hand-curated PROJECTION. `generate-data-entity`
 * and `generate-factory` reproduce the committed files VERBATIM (byte-for-byte)
 * so every hand edit survives; byte-identical re-derivation from a template was
 * rejected because the committed files are deliberately heterogeneous
 * (resolved vs. indexed getter types, `@Secret()` decorators, `Buffer` types,
 * inlined `PromptTemplate*` collision-fix unions, bespoke factories with custom
 * `Create*Props`/helpers) and a template could only unify them by changing
 * SEMANTIC tokens — which we forbid.
 *
 * Verbatim reproduction alone cannot detect the one drift that actually causes
 * data bugs: a Prisma model gains a persisted column but the entity/factory was
 * never updated (cf. the audit-column drift behind TASK-366). This module adds
 * that missing signal: for every entity/factory backed by a Prisma model it
 * compares the model's persisted scalar/enum columns (from DMMF) against the
 * fields the committed artifact actually surfaces, and fails `--check` (exit 1)
 * when a column is missing — naming the offending artifact + field.
 *
 * What is intentionally NOT enforced:
 *  - Relation fields (DMMF `kind === 'object'`). The entity layer curates
 *    relations heavily (many are deliberately omitted, e.g. `ApiKeyEntity` drops
 *    the `user` back-relation), so enforcing them would be all false positives.
 *  - Field TYPES. Types are hand-curated on purpose (`Buffer`, `@Secret()`
 *    targets, inlined collision-fix unions, `Decimal`), so we assert column
 *    PRESENCE by name only — never the exact type.
 *
 * Everything that is legitimately omitted is captured by the EXPLICIT allowlist
 * below, so any future omission is a deliberate, reviewable edit to this file
 * rather than a silent heuristic.
 */

/**
 * Field names supplied by the `BaseEntity` / `BaseTenantEntity` /
 * `BaseTaggedEntity` hierarchy (`packages/domains/src/common/baseEntity`). These
 * are columns on (almost) every Prisma model but are inherited rather than
 * re-declared on each entity's own interface, so they are subtracted from a
 * model's column set before comparison. DMMF reports the Prisma *field* name
 * (e.g. `version`, `metaData`) — not the `@map`-ed column (`_version`,
 * `_metadata`) — so these are the field names to match.
 */
export const BASE_ENTITY_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
    // BaseEntity (meta + audit + resource-status)
    'id',
    'version',
    'metaData',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'resourceStatus',
    'resourceStatusUpdatedAt',
    'resourceStatusUpdatedBy',
    // BaseTenantEntity
    'tenantId',
    // BaseTaggedEntity (`tags String[]`; the `Tags`/`Tenant` relations are
    // `kind: 'object'` and already excluded as relations)
    'tags',
]);

/**
 * Prisma models that are DELIBERATELY not projected into the entity/factory
 * layer. A model in this set is allowed to have no entity/factory; a model NOT
 * in this set that has no entity/factory fails the check (a new model was added
 * without its domain layer).
 */
export const OMITTED_MODELS: ReadonlySet<string> = new Set<string>([
    // fedl.prisma — federated-learning operational tables (server/worker-managed,
    // no domain-entity surface).
    'FedlClient',
    'FedlRound',
    'FedlUpdate',
    'FedlModelVersion',
    // rbac.prisma — CASL policy tables consumed directly by the PolicyEngine /
    // ability builder in the application layer; they are intentionally not
    // surfaced as domain entities (RBAC entities are Role/Permission/RolePermission).
    'Policy',
    'RolePolicy',
]);

/**
 * Hand-curated entities/factories that intentionally have NO backing Prisma
 * model (their "model name" — the file basename minus the `Entity`/`Factory`
 * suffix — resolves to nothing in DMMF, by design).
 */
export const MODEL_LESS_ENTITIES: ReadonlySet<string> = new Set<string>([
    'Permission',
    'RolePermission',
]);

/**
 * Per-model scalar/enum columns the curated layer intentionally omits from BOTH
 * the entity interface and the factory. Keyed by Prisma model name; the comment
 * names the entity the user reasons about (e.g. `RoleEntity`).
 */
export const OMITTED_SCALARS_BY_MODEL: Readonly<Record<string, ReadonlySet<string>>> = {
    // RoleEntity omits the built-in-role flag and the self-referential hierarchy
    // FK (`ParentRole`/`ChildRoles` are handled relationally, not as a scalar).
    Role: new Set<string>(['isSystemRole', 'parentRoleId']),
    // UserRoleAssignmentEntity omits the raw scope-overrides JSON column.
    UserRoleAssignment: new Set<string>(['scopeOverrides']),
};

/**
 * FACTORY-ONLY omissions: persisted columns a factory legitimately does NOT
 * accept as a creation input because they are populated AFTER creation by
 * another layer. The ENTITY still surfaces these (for read/round-trip), so they
 * are not in {@link OMITTED_SCALARS_BY_MODEL}; this set applies only to the
 * factory coverage pass. Keyed by Prisma model name.
 */
export const FACTORY_OMITTED_SCALARS_BY_MODEL: Readonly<Record<string, ReadonlySet<string>>> = {
    // TASK-328 A6 — the per-tenant "default pipeline" flag is flipped by a
    // dedicated set-default operation; a pipeline is always created `false`.
    AsrPipeline: new Set<string>(['isDefault']),
    // Nullable bucket FK assigned when the object is placed in a `TenantBucket`,
    // not at media-record creation.
    Media: new Set<string>(['bucketId']),
    // Populated after the job completes (the ContextItem it produced) — see the
    // schema comment "Created ContextItem (after completion)".
    TranscriptionJob: new Set<string>(['contextItemId']),
};

/**
 * At-rest field-encryption envelope columns (Data Encryption Initiative,
 * TASK-369). These are written by the repository encryption layer on persist —
 * factories accept only the PLAINTEXT business fields they wrap — so they are
 * never factory creation inputs. The ENTITY surfaces them (for read/round-trip),
 * so this skip is FACTORY-ONLY. Expressed as one documented rule rather than an
 * enumerated per-model list because the naming convention is uniform across the
 * ~17 encrypted tables (`encrypted<Field>`, `<...>keyVersion`, `dekWrapped`).
 */
function isWriteLayerEncryptionColumn(columnName: string): boolean {
    return columnName.startsWith('encrypted') || /keyVersion$/i.test(columnName) || columnName === 'dekWrapped';
}

/** A model's persisted, non-relation columns (scalar + enum) keyed by name. */
interface ModelColumns {
    modelName: string;
    /** Scalar + enum field names (relations excluded). */
    columns: Set<string>;
}

/** One entity/factory file reduced to the fields it actually surfaces. */
interface LayerArtifact {
    filePath: string;
    /** e.g. `ApiKeyEntity` / `ApiKeyFactory`. */
    artifactName: string;
    /** Prisma model this artifact projects, e.g. `ApiKey`. */
    modelName: string;
    /** Field names the artifact surfaces (interface props / constructed keys). */
    presentFields: Set<string>;
}

/** Result of comparing a layer (entity or factory) against the schema. */
export interface CoverageReport {
    layer: 'entity' | 'factory';
    /** Artifacts that are missing one or more required model columns. */
    missing: Array<{ artifactName: string; modelName: string; fields: string[] }>;
    /** Models with no artifact that are NOT in {@link OMITTED_MODELS}. */
    unexpectedModelsWithoutArtifact: string[];
    /** Artifacts whose model is absent from DMMF and NOT in {@link MODEL_LESS_ENTITIES}. */
    unexpectedArtifactsWithoutModel: string[];
    /** Counts for the clean-run summary line. */
    checkedArtifacts: number;
    checkedModels: number;
    /** Allowlist entries that never matched (helps keep the allowlist precise). */
    staleAllowlist: string[];
}

/**
 * Load every Prisma model's scalar/enum column set, merged across all discovered
 * domains (model names are globally unique). DMMF is derived directly from the
 * `.prisma` files via `@prisma/internals`, so a `--check` run reflects the
 * current schema on disk with no client regeneration required.
 */
export async function loadModelColumns(workspaceRoot: string): Promise<Map<string, ModelColumns>> {
    const byName = new Map<string, ModelColumns>();
    const domains = await discoverPrismaDomains(workspaceRoot);

    for (const domain of domains) {
        const dmmf: DMMF = await getDMMFForDomain(domain);
        for (const model of dmmf.datamodel.models) {
            const columns = new Set<string>();
            for (const field of model.fields) {
                // Skip relations; keep scalar + enum columns only.
                if (field.kind === 'object') {
                    continue;
                }
                columns.add(field.name);
            }
            byName.set(model.name, { modelName: model.name, columns });
        }
    }

    return byName;
}

/** Shared ts-morph project; files are parsed syntactically (no type resolution). */
function createParserProject(): Project {
    return new Project({
        useInMemoryFileSystem: false,
        skipFileDependencyResolution: true,
        compilerOptions: { allowJs: false },
    });
}

/**
 * Extract the field names an entity surfaces: the OWN properties of its
 * `I<Name>` interface (inherited base fields are intentionally not returned —
 * they are subtracted from the model column set instead).
 */
function parseEntityFields(project: Project, filePath: string): Set<string> {
    const sourceFile = project.addSourceFileAtPathIfExists(filePath) ?? project.addSourceFileAtPath(filePath);
    const base = path.basename(filePath, '.ts'); // e.g. ApiKeyEntity
    const iface =
        sourceFile.getInterface(`I${base}`) ??
        // Fallback: first interface that extends a base-entity interface.
        sourceFile.getInterfaces().find((i) => i.getExtends().length > 0);

    const fields = new Set<string>();
    if (iface) {
        for (const prop of iface.getProperties()) {
            fields.add(prop.getName());
        }
    }
    return fields;
}

/**
 * Extract the field names a factory surfaces: the union of its `Create*Props`
 * interface property names and the keys of every `new <Entity>({ ... })` object
 * literal it constructs. Using both sources tolerates factories that build via a
 * props variable as well as those that inline the literal.
 */
function parseFactoryFields(project: Project, filePath: string): Set<string> {
    const sourceFile = project.addSourceFileAtPathIfExists(filePath) ?? project.addSourceFileAtPath(filePath);
    const fields = new Set<string>();

    for (const iface of sourceFile.getInterfaces()) {
        if (iface.getName().startsWith('Create')) {
            for (const prop of iface.getProperties()) {
                fields.add(prop.getName());
            }
        }
    }

    collectConstructedObjectKeys(sourceFile, fields);
    return fields;
}

/** Union the property keys of every `new X({ ...literal... })` in the file. */
function collectConstructedObjectKeys(sourceFile: SourceFile, into: Set<string>): void {
    for (const newExpr of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const firstArg = newExpr.getArguments()[0];
        const objectLiteral = firstArg?.asKind(SyntaxKind.ObjectLiteralExpression);
        if (!objectLiteral) {
            continue;
        }
        for (const prop of objectLiteral.getProperties()) {
            const assignment =
                prop.asKind(SyntaxKind.PropertyAssignment) ?? prop.asKind(SyntaxKind.ShorthandPropertyAssignment);
            if (assignment) {
                into.add(assignment.getName());
            }
        }
    }
}

/** List `<name>.ts` files under each domain folder for the given suffix. */
function listArtifacts(generatedRoot: string, suffix: string): string[] {
    if (!fs.existsSync(generatedRoot)) {
        return [];
    }
    const files: string[] = [];
    for (const entry of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '__tests__') {
            continue;
        }
        const domainDir = path.join(generatedRoot, entry.name);
        for (const file of fs.readdirSync(domainDir)) {
            if (file.endsWith(`${suffix}.ts`)) {
                files.push(path.join(domainDir, file));
            }
        }
    }
    return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Compare a layer (entity or factory) against the Prisma schema and report any
 * curated-projection violations. Pure given its inputs (no logging / no exit).
 */
export function compareLayerCoverage(
    layer: 'entity' | 'factory',
    artifacts: LayerArtifact[],
    models: Map<string, ModelColumns>,
): CoverageReport {
    const missing: CoverageReport['missing'] = [];
    const unexpectedArtifactsWithoutModel: string[] = [];
    const projectedModels = new Set<string>();
    const usedAllowlistKeys = new Set<string>();

    for (const artifact of artifacts) {
        if (MODEL_LESS_ENTITIES.has(artifact.modelName)) {
            usedAllowlistKeys.add(`model-less:${artifact.modelName}`);
            continue;
        }

        const model = models.get(artifact.modelName);
        if (!model) {
            unexpectedArtifactsWithoutModel.push(artifact.artifactName);
            continue;
        }
        projectedModels.add(artifact.modelName);

        const omittedScalars = OMITTED_SCALARS_BY_MODEL[artifact.modelName] ?? new Set<string>();
        const factoryOmittedScalars =
            layer === 'factory' ? FACTORY_OMITTED_SCALARS_BY_MODEL[artifact.modelName] ?? new Set<string>() : null;
        const missingFields: string[] = [];
        for (const column of model.columns) {
            if (BASE_ENTITY_FIELD_NAMES.has(column)) {
                continue;
            }
            if (omittedScalars.has(column)) {
                usedAllowlistKeys.add(`omitted-scalar:${artifact.modelName}.${column}`);
                continue;
            }
            if (layer === 'factory') {
                // Encryption envelope is repository-written, never a factory input.
                if (isWriteLayerEncryptionColumn(column)) {
                    continue;
                }
                if (factoryOmittedScalars?.has(column)) {
                    usedAllowlistKeys.add(`factory-omitted:${artifact.modelName}.${column}`);
                    continue;
                }
            }
            if (!artifact.presentFields.has(column)) {
                missingFields.push(column);
            }
        }
        if (missingFields.length > 0) {
            missing.push({
                artifactName: artifact.artifactName,
                modelName: artifact.modelName,
                fields: missingFields.sort((a, b) => a.localeCompare(b)),
            });
        }
    }

    const unexpectedModelsWithoutArtifact: string[] = [];
    for (const modelName of models.keys()) {
        if (projectedModels.has(modelName) || OMITTED_MODELS.has(modelName)) {
            if (OMITTED_MODELS.has(modelName) && !projectedModels.has(modelName)) {
                usedAllowlistKeys.add(`omitted-model:${modelName}`);
            }
            continue;
        }
        unexpectedModelsWithoutArtifact.push(modelName);
    }

    const staleAllowlist = collectStaleAllowlist(layer, usedAllowlistKeys);

    return {
        layer,
        missing,
        unexpectedModelsWithoutArtifact: unexpectedModelsWithoutArtifact.sort((a, b) => a.localeCompare(b)),
        unexpectedArtifactsWithoutModel: unexpectedArtifactsWithoutModel.sort((a, b) => a.localeCompare(b)),
        checkedArtifacts: artifacts.length,
        checkedModels: models.size,
        staleAllowlist,
    };
}

/** Identify allowlist entries that did not correspond to a real omission. */
function collectStaleAllowlist(layer: 'entity' | 'factory', used: Set<string>): string[] {
    const stale: string[] = [];
    for (const model of OMITTED_MODELS) {
        if (!used.has(`omitted-model:${model}`)) {
            stale.push(`OMITTED_MODELS: ${model}`);
        }
    }
    for (const entity of MODEL_LESS_ENTITIES) {
        if (!used.has(`model-less:${entity}`)) {
            stale.push(`MODEL_LESS_ENTITIES: ${entity}`);
        }
    }
    for (const [model, columns] of Object.entries(OMITTED_SCALARS_BY_MODEL)) {
        for (const column of columns) {
            if (!used.has(`omitted-scalar:${model}.${column}`)) {
                stale.push(`OMITTED_SCALARS_BY_MODEL: ${model}.${column}`);
            }
        }
    }
    // FACTORY_OMITTED_SCALARS only participate in the factory pass.
    if (layer === 'factory') {
        for (const [model, columns] of Object.entries(FACTORY_OMITTED_SCALARS_BY_MODEL)) {
            for (const column of columns) {
                if (!used.has(`factory-omitted:${model}.${column}`)) {
                    stale.push(`FACTORY_OMITTED_SCALARS_BY_MODEL: ${model}.${column}`);
                }
            }
        }
    }
    return stale.sort((a, b) => a.localeCompare(b));
}

/**
 * Run the content-aware schema-coverage check for one layer and log the result.
 *
 * @returns `0` when coverage is clean, `1` when a curated-projection violation
 * is found (missing model column, an un-allowlisted model without an artifact,
 * or an artifact whose model no longer exists).
 */
export async function reportSchemaCoverage(options: {
    layer: 'entity' | 'factory';
    generatedRoot: string;
    workspaceRoot: string;
    logger: Logger;
}): Promise<number> {
    const { layer, generatedRoot, workspaceRoot, logger } = options;
    const suffix = layer === 'entity' ? 'Entity' : 'Factory';

    const models = await loadModelColumns(workspaceRoot);
    const project = createParserProject();

    const artifacts: LayerArtifact[] = listArtifacts(generatedRoot, suffix).map((filePath) => {
        const artifactName = path.basename(filePath, '.ts');
        const modelName = artifactName.slice(0, -suffix.length);
        const presentFields =
            layer === 'entity' ? parseEntityFields(project, filePath) : parseFactoryFields(project, filePath);
        return { filePath, artifactName, modelName, presentFields };
    });

    const report = compareLayerCoverage(layer, artifacts, models);

    if (report.staleAllowlist.length > 0) {
        logger.warn(
            `Schema-coverage allowlist has ${report.staleAllowlist.length} stale entr${report.staleAllowlist.length === 1 ? 'y' : 'ies'} (no longer needed — consider removing):\n` +
                report.staleAllowlist.map((entry) => `  - ${entry}`).join('\n'),
        );
    }

    const hasDrift =
        report.missing.length > 0 ||
        report.unexpectedModelsWithoutArtifact.length > 0 ||
        report.unexpectedArtifactsWithoutModel.length > 0;

    if (!hasDrift) {
        logger.info(
            `Schema coverage OK: ${report.checkedArtifacts} ${layer} artifact(s) cover every persisted column of ${report.checkedModels} Prisma model(s) (curated-projection allowlist applied).`,
        );
        return 0;
    }

    logger.error(`Schema-coverage drift detected in the ${layer} layer:`);
    for (const entry of report.missing) {
        logger.error(
            `  ${entry.artifactName} is missing model column(s) from Prisma model "${entry.modelName}": ${entry.fields.join(', ')}`,
        );
    }
    for (const modelName of report.unexpectedModelsWithoutArtifact) {
        logger.error(
            `  Prisma model "${modelName}" has no ${layer} (add one, or add "${modelName}" to OMITTED_MODELS in utils/schemaCoverage.ts if the omission is intentional).`,
        );
    }
    for (const artifactName of report.unexpectedArtifactsWithoutModel) {
        logger.error(
            `  ${artifactName} has no backing Prisma model (add "${artifactName.slice(0, -suffix.length)}" to MODEL_LESS_ENTITIES in utils/schemaCoverage.ts if this is intentional).`,
        );
    }
    logger.error(
        `Update the ${layer} layer to surface the column(s), or record the deliberate omission in utils/schemaCoverage.ts.`,
    );

    return 1;
}

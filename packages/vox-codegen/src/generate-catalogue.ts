/**
 * Turn a published catalogue into one committable TypeScript file per plane (TASK-931).
 *
 * Emits, per entry, `Agent_<Slug>_Input` / `Agent_<Slug>_Output` (and the `Workflow_` pair),
 * plus a map keyed by the SLUG — because the slug is what a call site actually passes
 * (`hope.agents.invoke('note-writer', …)`), and a map keyed by the PascalCase type name would
 * be a lookup nobody can perform from the value they hold.
 *
 * The same `jsonSchemaSubsetToTs` transpiler the consultation-context mode uses, deliberately:
 * agent and workflow schemas are authored through the same subset gate, so a second renderer
 * would be a second place for `oneOf` discrimination and enum unions to go wrong.
 *
 * An entry whose schema is `null` gets `unknown`, not `Record<string, unknown>`. "The
 * definition declares no contract" and "the contract is an open object" are different facts,
 * and `unknown` is the one that makes a call site prove what it is sending.
 */

import { jsonSchemaSubsetToTs } from './schema-to-ts';
import type { PublishedAgent, PublishedCatalogue, PublishedWorkflow } from './types';

/** Which plane a generated file describes. */
export type CatalogueSurface = 'agents' | 'workflows';

export interface GenerateCatalogueOptions {
  surface: CatalogueSurface;
  /** Recorded in the header, so a reader knows which HOPE the file was generated from. */
  baseUrl: string;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  generatedAt?: Date;
}

export interface GeneratedCatalogueFile {
  contents: string;
  /** How many entries were typed. `0` means the tenant has published none on this plane. */
  count: number;
}

function toPascalCase(key: string): string {
  const parts = key.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'Unnamed';
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase()).join('');
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let attempt = 2;
  while (taken.has(name)) {
    name = `${base}${attempt}`;
    attempt += 1;
  }
  taken.add(name);
  return name;
}

/** A slug is arbitrary tenant text, so it is a quoted key unless it happens to be an identifier. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function propertyKeyLiteral(key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
}

interface RenderedEntry {
  slug: string;
  inputType: string;
  outputType: string;
  declarations: string;
}

/**
 * `@contextSchema <slug> v<n> (follows latest | pinned)` / `@reviewNodes <ids>` — the two
 * workflow-only JSDoc tags a generated `Workflow_<Slug>_Input` type carries beside its
 * description, so a reader can tell which context schema version the trigger validates against
 * (and whether that tracks the tenant's pin) and which review-gate node ids exist to release,
 * without a second read of `hope.workflows.schema(slug)`.
 */
function workflowTags(entry: PublishedWorkflow): string[] {
  const tags: string[] = [];
  if (entry.contextSchema) {
    const { slug, versionNumber, followsLatest } = entry.contextSchema;
    tags.push(`@contextSchema ${slug} v${versionNumber} (${followsLatest ? 'follows latest' : 'pinned'})`);
  } else {
    tags.push('@contextSchema unbound');
  }
  if (entry.reviewNodes.length > 0) {
    tags.push(`@reviewNodes ${entry.reviewNodes.map((n) => n.nodeId).join(', ')}`);
  }
  return tags;
}

function renderEntry(prefix: 'Agent' | 'Workflow', entry: PublishedAgent | PublishedWorkflow, taken: Set<string>): RenderedEntry {
  const stem = uniqueName(`${prefix}_${toPascalCase(entry.slug)}`, taken);
  const inputType = `${stem}_Input`;
  const outputType = `${stem}_Output`;

  const describe = (): string => {
    const version = entry.versionNumber === null ? '' : ` v${entry.versionNumber}`;
    const detail = 'task' in entry && entry.task ? ` — ${entry.task}` : '';
    return `\`${entry.slug}\`${version} — ${entry.name}${detail}`;
  };

  const render = (schema: Record<string, unknown> | null, path: string): string =>
    // `unknown`, never an open object: an undeclared contract is a fact, not a permission.
    schema === null ? 'unknown' : jsonSchemaSubsetToTs(schema, { path });

  const tags = prefix === 'Workflow' ? workflowTags(entry as PublishedWorkflow) : [];
  const inputDoc = tags.length === 0 ? `/** ${describe()} */` : `/**\n * ${describe()}\n * ${tags.join('\n * ')}\n */`;

  return {
    slug: entry.slug,
    inputType,
    outputType,
    declarations: [
      inputDoc,
      `export type ${inputType} = ${render(entry.inputSchema, `${entry.slug}.inputSchema`)};`,
      '',
      `/** Output of ${describe()} */`,
      `export type ${outputType} = ${render(entry.outputSchema, `${entry.slug}.outputSchema`)};`,
    ].join('\n'),
  };
}

function renderMap(mapName: string, keyTypeName: string, entries: RenderedEntry[]): string {
  if (entries.length === 0) {
    return [`export type ${mapName} = Record<string, never>;`, `export type ${keyTypeName} = keyof ${mapName};`].join('\n');
  }
  const members = entries
    .map((entry) => `  ${propertyKeyLiteral(entry.slug)}: { input: ${entry.inputType}; output: ${entry.outputType} };`)
    .join('\n');
  return [`export interface ${mapName} {\n${members}\n}`, `export type ${keyTypeName} = keyof ${mapName};`].join('\n');
}

function header(options: GenerateCatalogueOptions, count: number): string {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const plane = options.surface === 'agents' ? 'agents' : 'workflows';
  return [
    '/**',
    ' * AUTO-GENERATED by @arcaai/vox-codegen — DO NOT EDIT BY HAND.',
    ' *',
    ` * Source: ${options.baseUrl} — the PUBLISHED ${plane} of the tenant this API key belongs to.`,
    ` * Entries: ${count}`,
    ` * Generated: ${generatedAt}`,
    ' *',
    ' * A BUILD-TIME convenience over runtime discovery, never a replacement for it. A tenant can',
    ' * publish a new version between two runs of this generator, and this file will not know',
    ' * until regenerated — so treat these types as the shape you BUILT against, not as a promise',
    ' * about the shape you will receive. The gateway validates every invocation against the live',
    ' * schema regardless of what compiled here.',
    ' *',
    ` * Regenerate: npx @arcaai/vox-codegen --api-key <key> --base-url ${options.baseUrl} --${plane}`,
    ' */',
  ].join('\n');
}

/** Build the generated `.ts` source for one plane of a published catalogue. */
export function generateCatalogueTypes(catalogue: PublishedCatalogue, options: GenerateCatalogueOptions): GeneratedCatalogueFile {
  const taken = new Set<string>();
  const isAgents = options.surface === 'agents';
  const entries = isAgents ? catalogue.agents : catalogue.workflows;
  const rendered = entries.map((entry) => renderEntry(isAgents ? 'Agent' : 'Workflow', entry, taken));

  const sections = [header(options, rendered.length)];
  if (rendered.length === 0) {
    sections.push(`// This tenant has published no ${options.surface}, or the API key can see none.`);
  } else {
    sections.push(rendered.map((entry) => entry.declarations).join('\n\n'));
  }
  sections.push(isAgents ? renderMap('AgentContractMap', 'AgentSlug', rendered) : renderMap('WorkflowContractMap', 'WorkflowSlug', rendered));

  return { contents: `${sections.join('\n\n')}\n`, count: rendered.length };
}

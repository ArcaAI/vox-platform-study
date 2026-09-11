/**
 * Turns a discovery bundle (`ConsultationSchemaBundle`) into one committable
 * TypeScript source file: a named type per `STRUCTURED` kind/output, plus a
 * `ConsultationContextKindMap` / `ConsultationContextOutputMap` for
 * exhaustive lookups. Non-`STRUCTURED` kinds (`STREAM_AUDIO`, `TEXT`,
 * `DOCUMENT`, `IMAGE`) carry no `fields` to type — they get a one-line
 * comment instead of a payload type, since `addContext()` never validates a
 * `payload` for them (`useArcaSession.addContext`,).
 */

import { jsonSchemaSubsetToTs } from './schema-to-ts';
import type { ConsultationSchemaBundle, ContextKindDeclaration, ContextOutputDeclaration } from './types';

export interface GenerateOptions {
  tenantId: string;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  generatedAt?: Date;
}

export interface GeneratedFile {
  contents: string;
  /** True when the tenant has no schema configured (`definition === null`). */
  unconfigured: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPascalCase(key: string): string {
  const parts = key.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'Unnamed';
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function propertyKeyLiteral(key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? key : JSON.stringify(key);
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

/** JSDoc text `generate.ts` attaches to a kind's marked user-identity property (TASK-950). */
const IDENTITY_ANNOTATION =
  "@identity — the clinician's staff identifier; a service-account caller's `open()` resolves or provisions the HOPE user from it (TASK-950).";

/** JSDoc text for a kind's marked `department` property (TASK-951). */
function departmentAnnotation(by: string): string {
  return `@role department (by ${by}) — selects the consultation's department, resolved against the tenant's own departments (TASK-951).`;
}

/** JSDoc text for a kind's marked `visitType` property (TASK-951). */
const VISIT_TYPE_ANNOTATION =
  "@role visitType — matched through the platform's visit-type catalogue and recorded on the consultation, taking precedence over the parent-consultation-derived signal (TASK-951).";

/** JSDoc text for a kind's marked `externalRef` property (TASK-951). */
const EXTERNAL_REF_ANNOTATION =
  "@role externalRef — an external system's own identifier for this encounter, persisted on the consultation's metadata (TASK-951).";

/** JSDoc text attached at the TYPE level for a `materializeAs: 'CASE_NOTE'` kind (TASK-951). */
const MATERIALIZE_AS_CASE_NOTE_ANNOTATION =
  '@materializeAs CASE_NOTE — every array entry of this payload is ALSO written as one CASE_NOTE context item at open() (TASK-951).';

/** JSDoc text attached at the TYPE level for a `streamContext: true` kind (TASK-951). */
const STREAM_CONTEXT_ANNOTATION =
  '@streamContext — echoed verbatim on every transcript segment of the STT session it was submitted to (TASK-951).';

/**
 * `{ [field]: annotation }` for every marker on `entry` (`userIdentity`,
 * `department`, `visitType`, `externalRef`) whose named field is actually one
 * of `fields`'s own properties — `undefined` when none apply (no markers, an
 * output entry which never carries one, or every marker names a property
 * this bundle does not have). Never throws: a malformed marker on untrusted
 * wire JSON just means no annotation for that role, not a broken generator
 * run. Two roles could in principle name the same property; the later check
 * below wins for that field, which is an acceptable, harmless tie-break
 * since the authoring gate limits each role to at most one property anyway.
 */
function roleAnnotations(entry: ContextKindDeclaration | ContextOutputDeclaration, fields: Record<string, unknown>): Record<string, string> | undefined {
  const properties = isPlainObject(fields.properties) ? fields.properties : undefined;
  if (!properties) return undefined;
  const record = entry as Record<string, unknown>;
  const annotations: Record<string, string> = {};

  const userIdentity = record.userIdentity;
  if (isPlainObject(userIdentity) && typeof userIdentity.field === 'string' && userIdentity.field.length > 0 && userIdentity.field in properties) {
    annotations[userIdentity.field] = IDENTITY_ANNOTATION;
  }

  const department = record.department;
  if (isPlainObject(department) && typeof department.field === 'string' && department.field.length > 0 && department.field in properties) {
    const by = department.by;
    if (by === 'code' || by === 'name') {
      annotations[department.field] = departmentAnnotation(by);
    }
  }

  const visitType = record.visitType;
  if (isPlainObject(visitType) && typeof visitType.field === 'string' && visitType.field.length > 0 && visitType.field in properties) {
    annotations[visitType.field] = VISIT_TYPE_ANNOTATION;
  }

  const externalRef = record.externalRef;
  if (isPlainObject(externalRef) && typeof externalRef.field === 'string' && externalRef.field.length > 0 && externalRef.field in properties) {
    annotations[externalRef.field] = EXTERNAL_REF_ANNOTATION;
  }

  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * TYPE-LEVEL JSDoc lines for a `materializeAs`/`streamContext`-marked kind
 * (TASK-951) — `[]` when neither marker is present (an output entry, or a
 * kind declaring neither), which is what keeps an unmarked bundle's output
 * byte-identical to before this ticket.
 */
function typeLevelAnnotations(entry: ContextKindDeclaration | ContextOutputDeclaration): string[] {
  const record = entry as Record<string, unknown>;
  const tags: string[] = [];
  if (record.materializeAs === 'CASE_NOTE') tags.push(MATERIALIZE_AS_CASE_NOTE_ANNOTATION);
  if (record.streamContext === true) tags.push(STREAM_CONTEXT_ANNOTATION);
  return tags;
}

interface RenderedEntry {
  key: string;
  typeName: string;
  declaration: string;
}

/** One declaration line per structured entry, plus a passthrough note for non-STRUCTURED kinds. */
function renderEntries<T extends ContextKindDeclaration | ContextOutputDeclaration>(
  entries: T[],
  suffix: 'Payload' | 'Output',
  taken: Set<string>,
): { rendered: RenderedEntry[]; notes: string[] } {
  const rendered: RenderedEntry[] = [];
  const notes: string[] = [];

  for (const entry of entries) {
    if (entry.primitive !== 'STRUCTURED') {
      notes.push(`// \`${entry.key}\` — primitive ${JSON.stringify(entry.primitive)}, no structured payload to type.`);
      continue;
    }
    if (!isPlainObject(entry.fields)) {
      // A published STRUCTURED kind always carries `fields` (the server
      // requires it), but this reads untrusted wire JSON,
      // so stay defensive rather than throw on an otherwise-harmless gap.
      notes.push(`// \`${entry.key}\` — declared STRUCTURED but has no \`fields\`; skipped.`);
      continue;
    }
    const typeName = uniqueName(`${toPascalCase(entry.key)}${suffix}`, taken);
    const expr = jsonSchemaSubsetToTs(entry.fields, { path: `${entry.key}.fields`, annotations: roleAnnotations(entry, entry.fields) });
    const label = entry.label ? ` — ${entry.label}` : '';
    const typeTags = typeLevelAnnotations(entry);
    const doc =
      typeTags.length === 0
        ? `/** \`${entry.key}\`${label} */`
        : `/**\n * \`${entry.key}\`${label}\n * ${typeTags.join('\n * ')}\n */`;
    rendered.push({
      key: entry.key,
      typeName,
      declaration: `${doc}\nexport type ${typeName} = ${expr};`,
    });
  }

  return { rendered, notes };
}

function renderMap(mapName: string, keyTypeName: string, entries: RenderedEntry[]): string {
  if (entries.length === 0) {
    return [`export type ${mapName} = Record<string, never>;`, `export type ${keyTypeName} = keyof ${mapName};`].join('\n');
  }
  const members = entries.map((entry) => `  ${propertyKeyLiteral(entry.key)}: ${entry.typeName};`).join('\n');
  return [`export interface ${mapName} {\n${members}\n}`, `export type ${keyTypeName} = keyof ${mapName};`].join('\n');
}

function header(bundle: ConsultationSchemaBundle, options: GenerateOptions): string {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const schemaLine = bundle.slug
    ? `Schema: ${bundle.slug} v${bundle.versionNumber ?? '?'} (${bundle.contextSchemaVersionId ?? '?'})`
    : 'Schema: (unconfigured — this tenant has not published a context schema)';
  return [
    '/**',
    ' * AUTO-GENERATED by @arcaai/vox-codegen — DO NOT EDIT BY HAND.',
    ' *',
    ` * Tenant: ${options.tenantId}`,
    ` * ${schemaLine}`,
    ` * Generated: ${generatedAt}`,
    ' *',
    ' * This file is a BUILD-TIME CONVENIENCE, never a replacement for runtime',
    ' * discovery. `useConsultationSchema()` (`@arcaai/vox`) remains the wire',
    ' * contract: a tenant can publish a new kind, or change an existing one,',
    ' * between two runs of this generator, and this file will not know until',
    ' * regenerated. Never gate application logic on these types alone —',
    ' * validate against the live discovery bundle at the boundary where a',
    ' * payload is actually submitted (`useArcaSession().addContext()` already',
    ' * does this).',
    ' *',
    ' * Regenerate: npx @arcaai/vox-codegen --tenant <tenantId> [--watch]',
    ' */',
  ].join('\n');
}

/** Build the full generated `.ts` source for one discovery bundle. */
export function generateConsultationSchemaTypes(bundle: ConsultationSchemaBundle, options: GenerateOptions): GeneratedFile {
  const unconfigured = bundle.definition === null;
  const taken = new Set<string>();

  const kinds = bundle.definition?.kinds ?? [];
  const outputs = bundle.definition?.outputs ?? [];

  const { rendered: kindTypes, notes: kindNotes } = renderEntries(kinds, 'Payload', taken);
  const { rendered: outputTypes, notes: outputNotes } = renderEntries(outputs, 'Output', taken);

  const sections = [header(bundle, options)];

  if (unconfigured) {
    sections.push('// No consultation context schema is configured for this tenant.');
  }

  if (kindTypes.length > 0 || kindNotes.length > 0) {
    sections.push(['// ---- Context kinds ----', ...kindNotes, ...kindTypes.map((entry) => entry.declaration)].join('\n\n'));
  }
  sections.push(renderMap('ConsultationContextKindMap', 'ConsultationContextKindKey', kindTypes));

  if (outputTypes.length > 0 || outputNotes.length > 0) {
    sections.push(['// ---- Outputs ----', ...outputNotes, ...outputTypes.map((entry) => entry.declaration)].join('\n\n'));
  }
  sections.push(renderMap('ConsultationContextOutputMap', 'ConsultationContextOutputKey', outputTypes));

  return {
    contents: `${sections.join('\n\n')}\n`,
    unconfigured,
  };
}

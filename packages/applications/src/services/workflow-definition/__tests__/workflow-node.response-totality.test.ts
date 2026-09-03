/**
 * task 11 — `toNodeResponse` must be a TOTAL projection of `WorkflowNodeDescriptor`.
 *
 * ## Why this test is shaped the way it is
 *
 * `WorkflowDefinitionDtoMapper.toNodeResponse` copies the descriptor into the DTO field by
 * field. That shape is correct (a response DTO is a deliberate contract, not a spread of an
 * internal type) but it has one failure mode, and it is silent: a field added to the descriptor
 * is simply never assigned, the endpoint keeps returning 200, and the consumer — the Studio
 * canvas, the SDK — cannot tell "the platform has no value for this" from "the gateway dropped
 * it". That is exactly what happened to all seven contract fields (`inputs`, `outputs`,
 * `trigger`, `lane`, `requires`, `idempotent`, `schemaVersion`, plus `evalGate`): the contract
 * package grew them, and `GET /api/v1/admin/workflow-nodes` never showed one of them.
 *
 * So this test does NOT list the fields it expects. A hand-maintained list has the same failure
 * mode as the mapper it is guarding — the next field gets dropped from BOTH. Instead the
 * expected field set is DERIVED, from three independent sources that fail in different ways:
 *
 * 1. **The interface source text** (`node-registry.ts`). The authoritative list, and the only
 *    source that can see an OPTIONAL field which no registry entry populates (`evalGate` is
 *    `undefined` on all 33 nodes today — runtime reflection is blind to it).
 * 2. **A synthetic, fully-populated descriptor**, typed as `WorkflowNodeDescriptor`. A new
 *    REQUIRED field makes this file fail to COMPILE, which is the earliest possible signal.
 * 3. **Every real registry entry**, so the projection is proven against the data actually
 *    served, not only against a fixture.
 *
 * The value is compared too, not just the key's presence: a field that is declared on the DTO
 * but assigned the wrong descriptor field is the same defect wearing a better disguise.
 */
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import type { WorkflowNodeDescriptor } from '@arcaai/workflow-contract';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowNodeResponse } from '../dto';
import { WorkflowDefinitionDtoMapper } from '../workflow-definition.dto.mapper';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const NODE_REGISTRY_SOURCE = resolve(REPO_ROOT, 'packages/workflow-contract/src/node-registry.ts');

/**
 * The ONLY field whose name deliberately differs between the descriptor and the DTO.
 *
 * `descriptor.key` is the registry's map key; the wire calls it `type` because that is what a
 * graph node's `type` property holds (`WorkflowGraphNode.type`). Every other field is projected
 * under its own name — and this map is the place a future rename has to be declared, rather
 * than being indistinguishable from a dropped field.
 */
const DESCRIPTOR_TO_DTO_FIELD: Readonly<Record<string, string>> = Object.freeze({ key: 'type' });

/** Strip block and line comments so a doc comment can never be mistaken for a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The declared field names of `interface WorkflowNodeDescriptor`, read from source.
 *
 * Source text rather than reflection because a TypeScript interface has no runtime
 * representation at all, and an optional field populated by no registry entry is invisible to
 * every runtime technique. This is the same posture as the sibling grep-gate test: a claim made
 * in prose, made machine-checkable instead.
 */
function declaredDescriptorFields(): string[] {
  const source = readFileSync(NODE_REGISTRY_SOURCE, 'utf8');
  const opened = source.indexOf('export interface WorkflowNodeDescriptor {');
  expect(opened, `\`export interface WorkflowNodeDescriptor {\` not found in ${NODE_REGISTRY_SOURCE}`).toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf('{', opened) + 1;
  const bodyEnd = source.indexOf('\n}', bodyStart);
  expect(bodyEnd, 'unterminated WorkflowNodeDescriptor interface body').toBeGreaterThan(bodyStart);

  const fields = [...stripComments(source.slice(bodyStart, bodyEnd)).matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/gm)].map((match) => match[1]);

  // A parse that silently returned nothing would make every assertion below vacuously true —
  // the precise failure mode this whole file exists to prevent.
  expect(fields.length, 'parsed no fields off WorkflowNodeDescriptor — the parser, not the mapper, is broken').toBeGreaterThan(10);
  return fields;
}

/**
 * A descriptor with EVERY field populated, including the two optional ones.
 *
 * Typed (not `as`-cast) on purpose: adding a required field to `WorkflowNodeDescriptor` breaks
 * this literal at compile time. The values are deliberately distinct from any real registry
 * entry so a mapper that hardcoded a default instead of reading the descriptor still fails.
 */
const FULLY_POPULATED_DESCRIPTOR: WorkflowNodeDescriptor = {
  key: 'test.fullyPopulated',
  implemented: true,
  activityName: 'interpreter.testFullyPopulated',
  classes: ['gate', 'phiBearing'],
  paletteKey: 'consultation',
  critical: true,
  externalWrite: true,
  defaultTimeoutSeconds: 123,
  defaultMaxAttempts: 4,
  entitlementKey: 'featureTestOnly',
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  inputs: [
    { name: 'after', primitive: 'control', required: false, multiple: true },
    { name: 'in', primitive: 'transcript', required: true, multiple: false },
  ],
  outputs: [{ name: 'out', primitive: 'document', required: true, multiple: true }],
  trigger: 'per-turn',
  lane: 'realtime',
  requires: ['guard.consent'],
  idempotent: false,
  schemaVersion: 7,
  evalGate: { goldenSetId: 'golden-set-test', enabled: true },
};

/** `undefined` on the descriptor is `null` on the wire — a DTO must not emit absent keys. */
function normalize(value: unknown): unknown {
  return value === undefined ? null : value;
}

function assertTotalProjection(descriptor: WorkflowNodeDescriptor, fields: readonly string[]): void {
  const dto = WorkflowDefinitionDtoMapper.toNodeResponse(descriptor);
  const dtoRecord = dto as unknown as Record<string, unknown>;
  const descriptorRecord = descriptor as unknown as Record<string, unknown>;

  const dropped: string[] = [];
  const misprojected: string[] = [];

  for (const field of fields) {
    const dtoField = DESCRIPTOR_TO_DTO_FIELD[field] ?? field;
    if (!Object.prototype.hasOwnProperty.call(dtoRecord, dtoField)) {
      dropped.push(`${descriptor.key}.${field} -> WorkflowNodeResponse.${dtoField}`);
      continue;
    }
    const expected = normalize(descriptorRecord[field]);
    const actual = normalize(dtoRecord[dtoField]);
    try {
      expect(actual).toEqual(expected);
    } catch {
      misprojected.push(`${descriptor.key}.${field}: expected ${JSON.stringify(expected)}, DTO carried ${JSON.stringify(actual)}`);
    }
  }

  expect(
    dropped,
    'toNodeResponse silently dropped descriptor fields. Add them to WorkflowNodeResponse (with @ApiProperty/@ApiPropertyOptional) AND assign them in toNodeResponse:\n' +
      dropped.join('\n'),
  ).toEqual([]);
  expect(misprojected, 'toNodeResponse projected a field from the wrong source:\n' + misprojected.join('\n')).toEqual([]);
}

describe('WorkflowNodeResponse is a total projection of WorkflowNodeDescriptor', () => {
  const fields = declaredDescriptorFields();

  it('every field declared on WorkflowNodeDescriptor reaches the DTO (synthetic, fully-populated)', () => {
    assertTotalProjection(FULLY_POPULATED_DESCRIPTOR, fields);
  });

  it.each(Object.values(WORKFLOW_NODE_REGISTRY).map((descriptor) => [descriptor.key, descriptor] as const))(
    'every field reaches the DTO for the real registry entry %s',
    (_key, descriptor) => {
      assertTotalProjection(descriptor, fields);
    },
  );

  it('emits no DTO field that does not trace back to a descriptor field', () => {
    const projected = new Set(fields.map((field) => DESCRIPTOR_TO_DTO_FIELD[field] ?? field));
    const dto = WorkflowDefinitionDtoMapper.toNodeResponse(FULLY_POPULATED_DESCRIPTOR);

    const phantom = Object.keys(dto as unknown as Record<string, unknown>).filter((key) => !projected.has(key));

    expect(
      phantom,
      'the DTO carries fields with no descriptor source — either the descriptor grew a field this test cannot see, or the mapper is inventing data:\n' +
        phantom.join('\n'),
    ).toEqual([]);
  });

  it('declares every projected field on the response class for Swagger', () => {
    // A field assigned by the mapper but never declared with @ApiProperty is invisible in
    // openapi.json, so the generated SDK and the portal both stay blind to it — the same
    // silent drop, one layer further out.
    // `@nestjs/swagger` records declared properties on the prototype, each prefixed with ':'.
    const declared: string[] = ((Reflect.getMetadata('swagger/apiModelPropertiesArray', WorkflowNodeResponse.prototype) ?? []) as string[]).map(
      (entry) => entry.replace(/^:/, ''),
    );
    expect(declared.length, 'read no @ApiProperty metadata off WorkflowNodeResponse — the reflection key, not the DTO, is wrong').toBeGreaterThan(5);
    const swaggerDeclared = new Set(declared);

    const dto = WorkflowDefinitionDtoMapper.toNodeResponse(FULLY_POPULATED_DESCRIPTOR);
    const undeclared = Object.keys(dto as unknown as Record<string, unknown>).filter((key) => !swaggerDeclared.has(key));

    expect(undeclared, 'projected by the mapper but not declared with @ApiProperty/@ApiPropertyOptional:\n' + undeclared.join('\n')).toEqual([]);
  });
});

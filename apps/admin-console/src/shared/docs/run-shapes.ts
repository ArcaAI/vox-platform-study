/**
 * TASK-1036 §3.6 (lane C4) — the Input shape and Output shape the Integration tab prints for a
 * workflow, derived from its CONTEXT SCHEMA and from nothing else.
 *
 * "Input shape" and "Output shape" are console labels; the wire keeps `kinds` and `outputs`
 * (OD-6). So a developer reading the tab and a run being validated by the gateway agree on the
 * contract, this reads the same fields `payloadSchemaFromDefinition` does:
 *
 *  - an input row per KIND, then one per declared field of a STRUCTURED kind (the shared
 *    `schemaVariablePaths` derivation, so the editor, the publish gate and this tab cannot
 *    disagree about a path);
 *  - PHI is the KIND's class, inherited by its fields — a definition declares PHI per kind;
 *  - an audio declaration carries its delivery: an input streams unless it says `blob`, an
 *    output is a blob unless it says `stream` (`effectiveAudioDelivery`);
 *  - an inline payload schema is read one level deep and declares no PHI class.
 *
 * TOTAL: anything unreadable yields empty shapes and `exampleInput: null`. `null` and not `{}` on
 * purpose — an empty object reads as "this workflow takes nothing", which is false whenever the
 * schema is merely unknown (the convention `example-body.ts` set).
 *
 * This file is RENDERED DOCUMENTATION support; it reads no environment variable.
 */
import { schemaVariablePaths } from '@arcaai/workflow-contract';
import { exampleBodyFromJsonSchema } from './example-body';

export type ShapePhi = 'PHI' | 'NON_PHI';
export type ShapeDelivery = 'stream' | 'blob';

export interface ShapeField {
  /** Dotted path under the run input (`patient.age`) or the output field key (`note`). */
  path: string;
  /** The platform primitive for a kind (`TEXT`, `STRUCTURED`, …) or the JSON Schema type for a field. */
  type: string;
  required: boolean;
  /** `null` when the declaration carries no class (an inline schema, or an output). */
  phi: ShapePhi | null;
  description: string | null;
  /** Present on audio declarations only. */
  delivery?: ShapeDelivery;
}

export interface RunShapes {
  input: ShapeField[];
  output: ShapeField[];
  /** An input kind that is live audio on a socket — the JSON body cannot carry it. */
  streamAudioIn: boolean;
  /**
   * TASK-1042 — the ONE Input key whose kind is live audio, where a run takes `{ sttSessionId }`;
   * `null` when there is none or more than one (the caller then names it).
   */
  streamAudioField: string | null;
  /** An input kind that is an uploaded object (a DOCUMENT / IMAGE attachment, or blob audio). */
  attachmentsIn: boolean;
  /** An output kind that is live audio on a socket. */
  streamAudioOut: boolean;
  /** The smallest body the JSON input accepts; `null` when no schema is usable. */
  exampleInput: Record<string, unknown> | null;
}

const EMPTY: RunShapes = Object.freeze({
  input: [],
  output: [],
  streamAudioIn: false,
  streamAudioField: null,
  attachmentsIn: false,
  streamAudioOut: false,
  exampleInput: null,
}) as RunShapes;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function phiOf(value: unknown): ShapePhi | null {
  return value === 'PHI' || value === 'NON_PHI' ? value : null;
}

function audioDelivery(declaration: Record<string, unknown>, side: 'input' | 'output'): ShapeDelivery | undefined {
  if (declaration.primitive !== 'STREAM_AUDIO') return undefined;
  if (declaration.delivery === 'stream' || declaration.delivery === 'blob') return declaration.delivery;
  return side === 'input' ? 'stream' : 'blob';
}

const ATTACHMENT_PRIMITIVES = ['DOCUMENT', 'IMAGE'];
const MEDIA_ID_PLACEHOLDER = '<mediaId>';

function kindsOf(definition: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(definition.kinds) ? definition.kinds : []).filter(
    (kind): kind is Record<string, unknown> => isRecord(kind) && typeof kind.key === 'string' && kind.key.length > 0,
  );
}

/** The example for ONE kind, or `undefined` when it cannot travel in a JSON body. */
function exampleOfKind(kind: Record<string, unknown>): unknown {
  switch (kind.primitive) {
    case 'TEXT':
      return '…';
    case 'STRUCTURED':
      return exampleBodyFromJsonSchema(isRecord(kind.fields) ? kind.fields : null) ?? {};
    case 'DOCUMENT':
    case 'IMAGE':
      return MEDIA_ID_PLACEHOLDER;
    case 'STREAM_AUDIO':
      // Live audio never rides the JSON body; a blob is a stored object referenced by id.
      return audioDelivery(kind, 'input') === 'blob' ? MEDIA_ID_PLACEHOLDER : undefined;
    default:
      return undefined;
  }
}

function exampleOfKinds(kinds: Record<string, unknown>[]): Record<string, unknown> | null {
  // Required kinds are the minimal body; with none, every kind that CAN travel shows, so the
  // example teaches something rather than printing an empty object.
  const required = kinds.filter((kind) => kind.required === true);
  const chosen = required.length > 0 ? required : kinds;
  const body: Record<string, unknown> = {};
  for (const kind of chosen) {
    const value = exampleOfKind(kind);
    if (value !== undefined) body[kind.key as string] = value;
  }
  return Object.keys(body).length > 0 ? body : null;
}

function outputRows(definition: Record<string, unknown>): ShapeField[] {
  const outputs = Array.isArray(definition.outputs) ? definition.outputs : [];
  return outputs
    .filter((output): output is Record<string, unknown> => isRecord(output) && typeof output.key === 'string' && output.key.length > 0)
    .map((output) => {
      const delivery = audioDelivery(output, 'output');
      return {
        path: output.key as string,
        type: str(output.primitive) ?? 'any',
        required: false,
        phi: phiOf(output.phiClass),
        description: str(output.description) ?? str(output.label),
        ...(delivery ? { delivery } : {}),
      };
    });
}

/** A context-schema `definition` (`{ kinds, outputs }`) or an inline payload JSON Schema. */
export function deriveRunShapes(schema: unknown): RunShapes {
  if (!isRecord(schema)) return EMPTY;

  const kinds = kindsOf(schema);
  const deliveryByPath = new Map<string, ShapeDelivery>();
  for (const kind of kinds) {
    const delivery = audioDelivery(kind, 'input');
    if (delivery) deliveryByPath.set(kind.key as string, delivery);
  }

  const prefix = 'input.';
  const input: ShapeField[] = schemaVariablePaths(schema, 'input').map((entry) => {
    const path = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    const delivery = deliveryByPath.get(path);
    return {
      path,
      type: entry.type,
      required: entry.required,
      phi: phiOf(entry.phiClass),
      description: entry.description,
      ...(delivery ? { delivery } : {}),
    };
  });
  const output = outputRows(schema);

  const exampleInput = kinds.length > 0 ? exampleOfKinds(kinds) : exampleBodyFromJsonSchema(schema);

  const streamAudioKeys = kinds.filter((kind) => audioDelivery(kind, 'input') === 'stream').map((kind) => String(kind.key));
  return {
    input,
    output,
    streamAudioIn: streamAudioKeys.length > 0,
    streamAudioField: streamAudioKeys.length === 1 ? streamAudioKeys[0] : null,
    attachmentsIn: kinds.some((kind) => ATTACHMENT_PRIMITIVES.includes(String(kind.primitive)) || audioDelivery(kind, 'input') === 'blob'),
    streamAudioOut: output.some((row) => row.delivery === 'stream'),
    exampleInput,
  };
}

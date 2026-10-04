import { BadRequestException } from '@nestjs/common';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { isMediaReferenceSchema } from '../consultation-context-schema/context-schema-definition';
import { frozenTriggerPayloadSchema } from '../consultation-context-schema/context-schema-usages';

/** What the sandbox resolved for an attachment: a reference to tenant media, never bytes or a URI. */
export interface SandboxMediaReference {
  mediaId: string;
  mime: string;
  name: string;
  size: number;
}

interface MediaSlot {
  key: string;
  many: boolean;
  item: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A declared media kind: a media reference (`ONE`), or `anyOf [reference, list of references]` (`MANY`). */
function mediaSlotOf(key: string, schema: unknown): MediaSlot | null {
  if (isMediaReferenceSchema(schema)) return { key, many: false, item: schema as Record<string, unknown> };
  if (!isPlainObject(schema) || !Array.isArray(schema.anyOf)) return null;
  const item = schema.anyOf.find(isMediaReferenceSchema) as Record<string, unknown> | undefined;
  const list = schema.anyOf.find((branch) => isPlainObject(branch) && branch.type === 'array' && isMediaReferenceSchema(branch.items));
  return item && list ? { key, many: true, item } : null;
}

/** A declared streamed-audio kind: the open object whose `sttSessionId` names the session. */
function isStreamAudioSchema(schema: unknown): boolean {
  return isPlainObject(schema) && isPlainObject(schema.properties) && isPlainObject(schema.properties.sttSessionId) && !isMediaReferenceSchema(schema);
}

function undeclared(message: string): BadRequestException {
  return new BadRequestException({ code: 'SANDBOX_INPUT_UNDECLARED', message });
}

/**
 * TASK-1038 (F1) — the sandbox run payload: the JSON input, plus the attachments and the recording
 * placed where the workflow's INPUT SHAPE declares them.
 *
 * The trigger validates the payload against its bound schema with `additionalProperties: false`,
 * so a top-level `attachments` / `recording` key was refused on every bound workflow. On a BOUND
 * trigger each attachment goes to the first declared media kind (declaration order) whose
 * reference schema accepts it — its MIME type among that kind's declared types, and a `ONE` kind
 * taking a single reference — and the recording goes to the declared streamed-audio kind as
 * `{ sttSessionId }`. Anything with nowhere declared to go is a 400 (`SANDBOX_INPUT_UNDECLARED`):
 * a sandbox input never becomes a key the definition does not declare.
 *
 * An UNBOUND trigger (no resolved schema) validates nothing, so the legacy keys are kept for it.
 * Pure; throws before the caller writes anything.
 */
export function sandboxRunPayload(
  compiledConfig: unknown,
  input: Record<string, unknown>,
  attachments: SandboxMediaReference[] | undefined,
  recording: { sttSessionId: string } | undefined,
): Record<string, unknown> {
  const schema = frozenTriggerPayloadSchema(compiledConfig);
  if (schema === null) {
    return { ...input, ...(attachments ? { attachments } : {}), ...(recording ? { recording: { sttSessionId: recording.sttSessionId } } : {}) };
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const payload: Record<string, unknown> = { ...input };

  if (attachments?.length) {
    const slots = Object.entries(properties)
      .map(([key, kindSchema]) => mediaSlotOf(key, kindSchema))
      .filter((slot): slot is MediaSlot => slot !== null);
    for (const reference of attachments) {
      const slot = slots.find(
        (candidate) => jsonSchemaValueProblems(candidate.item, reference).length === 0 && (candidate.many || payload[candidate.key] === undefined),
      );
      if (!slot) {
        throw undeclared(
          `Attachment '${reference.mediaId}' (${reference.mime}) has nowhere to go: this workflow's input shape declares no ${
            slots.length > 0 ? 'free attachment kind that accepts that type' : 'attachment kind'
          }.`,
        );
      }
      if (slot.many) {
        const prior = payload[slot.key];
        payload[slot.key] = [...(prior === undefined ? [] : Array.isArray(prior) ? prior : [prior]), reference];
      } else {
        payload[slot.key] = reference;
      }
    }
  }

  if (recording) {
    const key = Object.keys(properties).find((candidate) => isStreamAudioSchema(properties[candidate]));
    if (key === undefined) throw undeclared("A recording has nowhere to go: this workflow's input shape declares no live audio.");
    payload[key] = { ...(isPlainObject(payload[key]) ? (payload[key] as Record<string, unknown>) : {}), sttSessionId: recording.sttSessionId };
  }

  return payload;
}

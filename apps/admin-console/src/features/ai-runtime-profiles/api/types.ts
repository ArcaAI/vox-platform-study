/**
 * Wire types for the platform AI runtime-profile plane (TASK-799 Phase 4, E.2).
 *
 * Shapes mirror the gateway DTOs (`AiRuntimeProfileResponse` /
 * `UpsertAiRuntimeProfileRequest` in @arcaai/applications) — the console cannot
 * import that server package, so the fields are re-declared here once.
 *
 * ## The one thing to know before reading these types
 *
 * A runtime profile is PLATFORM configuration. `AiRuntimeProfileService` pins
 * `tenantId` to the reserved SYSTEM tenant in every single method and refuses a
 * non-SYSTEM target with a `ForbiddenException`; the route is `manage:all` and
 * the service re-asserts super-admin on top. So although the response carries a
 * `tenantId` field — and the service signatures accept an optional `tenantId`
 * argument the controller never passes — there is exactly one tenant these rows
 * can belong to. The console models that reality (no tenant selector, no
 * working-tenant dependency) rather than the wider shape the DTO implies.
 */

/**
 * The empty-string sentinel that addresses a PROVIDER-LEVEL default row.
 *
 * `modelSlug` is a query parameter rather than a path segment precisely because
 * its default value is `''`, which cannot be expressed as a path segment.
 * Omitting the parameter therefore addresses the provider default — matching
 * the storage sentinel exactly.
 */
export const PROVIDER_DEFAULT_SLUG = '';

/** The knobs a profile carries. Every one is `null` = "no opinion", NOT zero. */
export interface RuntimeProfileKnobs {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxConcurrent: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  timeoutS: number | null;
  keepAliveSeconds: number | null;
  extraJson: Record<string, unknown> | null;
}

/** GET admin/ai-runtime-profiles[/row] — one (SYSTEM, provider, modelSlug) row. */
export interface AiRuntimeProfile extends RuntimeProfileKnobs {
  /** Always the reserved SYSTEM tenant; see the module note above. */
  tenantId: string;
  provider: string;
  /** `''` = the provider-level default row. */
  modelSlug: string;
  /** OCC token. 0 = the "no row yet" placeholder, which `PUT` uses to create. */
  version: number;
  updatedAt?: string;
}

/**
 * GET admin/ai-runtime-profiles/resolve — the per-field merge of the
 * model-scoped row over the provider-level default: exactly what the gateway
 * would inject. `isEmpty` means nothing is injected at all and the consuming
 * service keeps its own defaults.
 */
export interface ResolvedRuntimeProfile extends RuntimeProfileKnobs {
  provider: string;
  modelSlug: string;
  isEmpty: boolean;
}

/**
 * PUT admin/ai-runtime-profiles/row body.
 *
 * Sparse by design and with a THREE-WAY meaning per field that the editor has
 * to preserve: omit = leave the stored value untouched; `null` = clear the
 * override so the cascade falls through; a number = set it. Collapsing `null`
 * and omission would make "clear this knob" unexpressible.
 */
export interface UpsertAiRuntimeProfileRequest extends Partial<RuntimeProfileKnobs> {
  /** OCC token from the read ETag. `0` creates. */
  expectedVersion?: number;
}

/**
 * Server-side validation ranges, mirrored from `UpsertAiRuntimeProfileRequest`'s
 * class-validator decorators (which the service duplicates as clamps, so a
 * service-to-service caller cannot bypass them either).
 *
 * Mirrored here to fail an out-of-range value in the form — where the admin can
 * see which knob is wrong — instead of collecting a 400 whose `message` array
 * has to be parsed back into a field. The server remains the authority; this is
 * a nicer first line, never the only one.
 */
export interface KnobSpec {
  name: keyof RuntimeProfileKnobs;
  label: string;
  description: string;
  /** `integer` renders `inputMode="numeric"`; `decimal` allows fractions. */
  kind: 'integer' | 'decimal';
  min: number;
  max?: number;
  placeholder: string;
}

/** Sampling knobs — what the model generates. */
export const SAMPLING_KNOBS: readonly KnobSpec[] = [
  {
    name: 'temperature',
    label: 'Temperature',
    description: 'Sampling temperature. Lower is more deterministic.',
    kind: 'decimal',
    min: 0,
    max: 2,
    placeholder: '0.2',
  },
  { name: 'topP', label: 'Top-p', description: 'Nucleus sampling cutoff.', kind: 'decimal', min: 0, max: 1, placeholder: '0.95' },
  { name: 'maxTokens', label: 'Max tokens', description: 'Upper bound on generated tokens.', kind: 'integer', min: 0, placeholder: '2048' },
  {
    name: 'contextLength',
    label: 'Context length',
    description: 'Context window budget — n_ctx for GGUF engines, request context budget for API engines.',
    kind: 'integer',
    min: 0,
    placeholder: '8192',
  },
];

/** Capacity knobs — how hard the platform may drive the engine. */
export const CAPACITY_KNOBS: readonly KnobSpec[] = [
  {
    name: 'maxConcurrent',
    label: 'Max concurrent',
    description: 'Maximum in-flight requests against this provider/model.',
    kind: 'integer',
    min: 0,
    placeholder: '8',
  },
  { name: 'tpmLimit', label: 'Tokens per minute', description: 'Tokens-per-minute ceiling.', kind: 'integer', min: 0, placeholder: '120000' },
  { name: 'rpmLimit', label: 'Requests per minute', description: 'Requests-per-minute ceiling.', kind: 'integer', min: 0, placeholder: '600' },
];

/** Timing knobs — how long the platform waits, and how long a model stays warm. */
export const TIMING_KNOBS: readonly KnobSpec[] = [
  { name: 'timeoutS', label: 'Timeout (seconds)', description: 'Per-request timeout.', kind: 'integer', min: 0, placeholder: '300' },
  {
    name: 'keepAliveSeconds',
    label: 'Keep-alive (seconds)',
    description: 'Model-retention hint forwarded to server-managed engines.',
    kind: 'integer',
    min: 0,
    placeholder: '600',
  },
];

/** Every scalar knob, in display order. `extraJson` is edited separately. */
export const ALL_KNOBS: readonly KnobSpec[] = [...SAMPLING_KNOBS, ...CAPACITY_KNOBS, ...TIMING_KNOBS];

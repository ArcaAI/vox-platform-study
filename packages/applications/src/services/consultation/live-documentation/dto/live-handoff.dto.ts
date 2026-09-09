import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-932 R-16a — the LIVE HANDOFF: what the durable interpreter reads at the close of a
 * consultation, so its `onEnd` finalizer can bind the note the live lane actually produced.
 *
 * ## Why this exists
 *
 * A consultation-bound interpreter run SKIPS every `realtime` node (`_has_live_owner`,
 * `apps/harness/.../interpreter/workflow.py`) so exactly one runtime executes it — the live
 * executor in this service. That rule closed a double-write hazard and opened a different hole:
 * a skipped node stores no output, so the durable consumer of one (`n_finalize`, the seeded
 * `casenote-finalization` agent) resolved `bound_inputs: {}` and degraded with
 * "core.agent: nothing bound on `in`/`context` to generate from" on EVERY consultation.
 * Measured on the dev stack 2026-09-09: 29 consultations in `DRAINING`, none with a
 * `RAW_SUMMARY`.
 *
 * This is the handoff that closes it. Not a new store: {@link LiveHandoffResponse.outputs} is
 * the realtime executor's OWN `RealtimeRunResult.outputs` — the last successful output of each
 * node, keyed by node id, in the exact shape the durable lane would have cached — so the
 * interpreter binds it through the declared socket table with no special case on either side.
 *
 * ## This is a PHI transport
 *
 * `outputs` carries the running clinical note and the session's entities, and `context` carries
 * the clinician's own writing profile. Same class as `consultation:live-summary:{id}`: service-
 * token guarded, tenant-scoped, never logged.
 */
export class LiveHandoffResponse {
  @ApiProperty({
    description:
      'Whether the live session has finished and handed off. `false` means "ask again" — the clinician is still recording, or has not started; the interpreter polls and NEVER treats an absent handoff as an empty one, because an empty note published mid-consultation is the failure this flag exists to prevent.',
  })
  ended: boolean;

  @ApiPropertyOptional({ description: 'When the live session handed off (ISO 8601). Absent while `ended` is false.' })
  endedAt?: string;

  @ApiProperty({
    description:
      "The live lane's final outputs, keyed by the graph node id that produced them, filtered to the node ids the caller asked about. Each value is that node's own output object (a `core.agent` running the note publishes `{ text, sections, … }`). Legitimately EMPTY for a consultation that never recorded — the finalizer then degrades with its own named reason rather than being handed a fabricated note.",
    type: 'object',
    additionalProperties: true,
  })
  outputs: Record<string, Record<string, unknown>>;

  @ApiProperty({
    description:
      "Run-context additions the durable lane overlays onto its `trigger` context. Carries the clinician's EFFECTIVE DNA writing style (`dna_style_text`, `dna_style_id`) for prompt rendering, and their redaction/rewrite rules (`dna_redaction_rules` — the `{ id, type, match, pattern, replacement?, note? }` objects the harness `apply_redaction` activity takes, ABSENT rather than `[]` when the doctor authored none). Both are resolved here from ONE report and one decrypt, but each behind its OWN gate — the tenant's `agent.dna_style` / `agent.dna_redaction` declaration AND the doctor's toggle — so a tenant that enabled one and not the other gets exactly that, and neither half ever travels in a caller-composed run payload where it could be supplied or spoofed. Absent entirely when both gates are off or a gate cannot be read.",
    type: 'object',
    additionalProperties: true,
  })
  context: Record<string, unknown>;
}

/** The Redis-held record `LiveDocumentationService.stop` writes and the route reads back. */
export interface LiveHandoffRecord {
  endedAt: string;
  tenantId: string;
  outputs: Record<string, Record<string, unknown>>;
}

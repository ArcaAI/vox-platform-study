# TASK-1017 — Consultation-loop vision extraction: a selection plane and the image itself

| Field | Value |
|---|---|
| Status | **Pending**: split out of TASK-1016 by owner decision OD-2 (2026-09-29); plan and ODs not yet written |
| Type | feature (the capability was never actually wired) |
| Services | `apps/harness`, `apps/api` / `packages/applications` (selection + image delivery), `apps/text` (already accepts images) |
| Related | TASK-1016 (made `vision_extract_text` fail closed), TASK-662 (derive actions), TASK-890 (loop config) |

## Requirement Analysis

Every IMAGE context item dispatches `vision.extract_text`
(`LoopConfigService` `PRIMITIVE_DEFAULT_ACTIONS.IMAGE`), backed by the harness activity
`vision_extract_text`. Until TASK-1016 that activity:

1. named **no provider and no model**. `apps/text` has no default for either, so every call was
   refused with a 422, then swallowed as `derived=False`;
2. never sent the **image**, only the context item's text. `apps/text` accepts an image only as
   `content_parts` (`ImageContentPart`: base64 `data` + `media_type`).

TASK-1016 made the activity fail closed with `DeriveContextResult(derived=False,
reason="vision_model_unselected")` and no call to text. This ticket makes the capability real.

## Current State Evaluation (to verify when the ticket starts)

- **Selection.** No vision `AgentTask` exists (`SPEECH_TO_TEXT | TEXT_GENERATION | TEXT_TO_SPEECH |
  NAMED_ENTITY_RECOGNITION`). The `vlm.extract` `AiRoutingPolicy` key exists (kind
  VISION_EXTRACTION, model task type IMAGE_TEXT_TO_TEXT), with **deliberately no SYSTEM default**
  (seed `16-ai-routing-policy.ts` exemption: no deployable vision model on LM Studio) and **no
  runtime consumer**. It is NOT under a platform-only prefix, so tenant → SYSTEM resolution applies
  (rule 00 §2).
- **Transport.** No harness-reachable route resolves a routing key at activity time.
  `harness.judge` is snapshotted onto workflow input at start, and agents resolve through
  `GET /internal/agents/resolve`.
- **Image bytes.** The loop signal carries `text` / `text_ref`, not the image. Where the image
  bytes live (MinIO object behind the context item) and how the harness may fetch them (claim-check,
  or a gateway internal read) is still to be mapped.

## Open questions for the plan (candidate ODs)

1. The selection plane: `vlm.extract` routing policy resolved gateway-side (a new internal resolve,
   or a field on the pinned loop config), or a new vision agent task?
2. The platform default: which vision model, served by what (LM Studio `mmproj`, vLLM)? Keep the
   seed exemption until one is deployable?
3. Image delivery to the activity: fetch by context-item id through the gateway, or claim-check?
   PHI egress guard for a cloud vision provider (an image cannot be text-redacted, so is the
   posture block-only for cloud?).

## Implementation Plan

To be written (5-phase lifecycle, rule 01) once the ODs above are answered.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Ticket opened from TASK-1016 OD-2 (owner: "separate ticket"). |

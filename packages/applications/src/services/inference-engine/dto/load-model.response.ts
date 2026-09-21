import type { AiModelServingProfile } from '@arcaai/types';
import { ApiProperty } from '@nestjs/swagger';

/** Which tier supplied one resolved field: this request, the model row, or the platform default. */
export type LmStudioServingProfileSource = 'request' | 'model' | 'platform';

/**
 * The 202 body of `POST .../models/{modelKey}/load`.
 *
 * ⚠️ NOT REACHABLE ON THIS ENGINE BUILD. The route runs its whole gate chain —
 * privilege, existence, profile coherence, live VRAM budget — and then refuses
 * with **501 `ENGINE_LOAD_UNSUPPORTED`**, because no loader that can carry a
 * serving profile is reachable from the gateway: `POST /api/v1/models/load`
 * fails for every payload on this deployment (ticket §2.8) and cannot express
 * KV-cache quantization or GPU placement in any case, and the working
 * `@lmstudio/sdk` kvConfig websocket is driven over loopback inside the pod at
 * boot.
 *
 * This class is not aspirational padding: the 501 body carries the SAME three
 * fields (`applied`, `sources`, `estimateBytes`), so the console's
 * "show the precheck before arming the button" step (Phase 5) has a real answer
 * today, and the day a gateway-reachable loader lands the shape is already the
 * one every caller was written against.
 */
export class LoadLmStudioModelResponse {
  @ApiProperty({ description: 'The loaded instance handle — what a later unload takes.' })
  identifier!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The resolved serving profile the engine was asked for: this request over the model row over the platform default.',
  })
  applied!: AiModelServingProfile;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Dotted field path -> the tier that supplied it (`request` | `model` | `platform`). A field NO tier declared is absent, which means the engine`s own default applies.',
  })
  sources!: Record<string, LmStudioServingProfileSource>;

  @ApiProperty({
    description:
      'Expected resident VRAM: the MEASURED weights plus the DERIVED KV cache (`contextLength x parallel`, scaled by the KV element types). An estimate, and the number the 409 budget gate compares against the largest single card.',
  })
  estimateBytes!: number;
}

/** The 202 body of `POST .../models/{identifier}/unload`. */
export class UnloadLmStudioModelResponse {
  @ApiProperty({ description: 'Whether the engine accepted the unload.' })
  unloaded!: boolean;

  @ApiProperty({
    description:
      'ALWAYS `true`, and it is a warning rather than a capability. JIT loading cannot be disabled on this build — there is no CLI flag, no REST field and no settings key for it — so the next inference request reloads the model, on the JIT defaults (`lmStudio.jit.*`) rather than on the profile it was unloaded from. An unload is therefore ADVISORY: it returns VRAM now, it does not keep the model gone.',
  })
  jitReloadPossible!: true;
}

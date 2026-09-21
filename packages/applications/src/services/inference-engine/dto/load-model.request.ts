import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

/**
 * `POST admin/inference-engines/lm-studio/models/{modelKey}/load`.
 *
 * `profile` is declared as a plain object rather than a nested validated class
 * ON PURPOSE. Its vocabulary already has ONE owner —
 * `parseAiModelServingProfile` in `@arcaai/types`, the same validator the
 * stored `AiModel._metadata.serving` block and the pod's own loader read
 * through — and a second, decorator-shaped copy of that vocabulary here is how
 * the two drift apart. The global pipe treats an `@IsObject()` field as a leaf,
 * so the object arrives intact and the shared parser judges it.
 *
 * The parser's normal posture is `open-to-default`: a field it cannot read is
 * DROPPED and named. That is right for a STORED row, which must keep serving.
 * It is wrong for this request, which is a one-shot instruction from an
 * administrator: silently ignoring half of what they typed and loading anyway
 * is exactly the "served on parameters nobody chose" failure the ticket calls
 * worse than not starting. So a rejected field here becomes a 400.
 */
export class LoadLmStudioModelRequest {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Serving-profile overrides for THIS load, layered over the model row and then the platform default. Same vocabulary as `AiModel._metadata.serving`: `contextLength`, `parallel`, `flashAttention`, `kvCacheQuant.{k,v}`, `gpuSplit.{strategy,disabledGpus,priority,customRatio}`. Omit to load on the resolved model/platform profile. Any field the vocabulary does not accept is a 400, not a silent drop.',
  })
  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Proceed despite the live VRAM budget. Bypasses the 409 `VRAM_BUDGET_EXCEEDED` gate AND ONLY that gate — never the super-admin 403, never the 404 for an unknown model, never a 400 on an incoherent profile. The cards are time-sliced and give no memory isolation, so an over-budget load can take the STT and guardrail workloads down with it.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

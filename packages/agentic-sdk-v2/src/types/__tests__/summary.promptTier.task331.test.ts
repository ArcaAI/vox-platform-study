/**
 * SummaryResponse.structuredData prompt-tier typing (TASK-331 doc-06 F4).
 *
 * Compile-time guard (enforced by `tsc --noEmit`, which includes test files)
 * that the 3-tier prompt fallback is explicitly typed on `structuredData`:
 *   - `promptResolvedFrom?: 'preferred' | 'department' | 'default'`
 *   - `resolvedPromptId?: string`
 * while the open-ended index signature is preserved.
 */

import { describe, it, expect } from 'vitest';
import type { SummaryResponse } from '../summary';

type StructuredData = NonNullable<SummaryResponse['structuredData']>;

describe('SummaryResponse.structuredData — prompt tier (F4)', () => {
  it('types promptResolvedFrom as the resolution-tier union and resolvedPromptId as string', () => {
    const structuredData: StructuredData = {
      promptResolvedFrom: 'department',
      resolvedPromptId: 'prompt-template-1',
      // index signature still accepts arbitrary keys
      cacheHit: true,
    };

    // `promptResolvedFrom` must be the explicit union (not `unknown` from the
    // index signature): this assignment only compiles if the field is typed.
    const tier: 'preferred' | 'department' | 'default' | undefined = structuredData.promptResolvedFrom;
    const id: string | undefined = structuredData.resolvedPromptId;

    expect(tier).toBe('department');
    expect(id).toBe('prompt-template-1');
  });

  it('rejects values outside the resolution-tier union', () => {
    // @ts-expect-error 'unknown-tier' is not a member of the prompt-resolution union.
    const bad: StructuredData = { promptResolvedFrom: 'unknown-tier' };
    expect(bad).toBeDefined();
  });
});

/**
 * `VisitTypeService` is an `@Optional()` injection on
 * `LiveAgentResolutionService`, so it can be silently unwired — and the
 * symptom would be invisible: every live session would resolve the PLATFORM's
 * visit types instead of the tenant's, `(live, visitType)` bindings would never
 * fire, nothing would throw and no unit test would fail.
 *
 * Importing `PromptResolutionServiceModule` is NOT enough — it imports
 * `VisitTypeServiceModule` but does not re-export `VisitTypeService`, so the
 * provider does not reach this module's own injector. This is the guard on that
 * exact mistake.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_SOURCE = readFileSync(join(__dirname, '..', 'live-agent-resolution.service.module.ts'), 'utf8');
const PROMPT_RESOLUTION_MODULE_SOURCE = readFileSync(join(__dirname, '..', 'prompt-resolution.service.module.ts'), 'utf8');

describe('LiveAgentResolutionServiceModule', () => {
  it('imports VisitTypeServiceModule directly so the @Optional catalogue is actually provided', () => {
    expect(MODULE_SOURCE).toMatch(/imports:\s*\[[^\]]*VisitTypeServiceModule[^\]]*\]/);
  });

  it('cannot inherit it — PromptResolutionServiceModule does not export VisitTypeService', () => {
    expect(PROMPT_RESOLUTION_MODULE_SOURCE).toMatch(/exports:\s*\[\s*PromptResolutionService\s*\]/);
  });
});

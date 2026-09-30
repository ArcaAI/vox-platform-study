/**
 * One mount path for the models bucket, declared once (TASK-1023 OD-8).
 *
 * `@arcaai/types` declares `HOPE_MODELS_MOUNT` / `HOPE_MODELS_BUCKET`; the gateway re-exports them
 * from `@arcaai/applications` (its `localPath` derivation reads them) and the admin console shows
 * paths under the same mount. Every serving pod mounts the bucket at that path, so a second,
 * drifted literal anywhere would hand services a `localPath` that does not exist.
 *
 * The console may still carry its own literal or may import it from `@arcaai/types`: IF it
 * declares one, it must equal the contract value.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOPE_MODELS_BUCKET as TYPES_BUCKET, HOPE_MODELS_MOUNT as TYPES_MOUNT } from '../../packages/types/src/model-registry';
import {
  HOPE_MODELS_BUCKET as GATEWAY_BUCKET,
  HOPE_MODELS_MOUNT as GATEWAY_MOUNT,
  deriveLocalPath,
} from '../../packages/applications/src/services/ai-model/constants';

const CONSOLE_MODEL_META = path.resolve(__dirname, '../../apps/admin-console/src/features/ai-models/components/model-meta.ts');

/** The value of `export const <name> = '<literal>'` in a source file, or null when not declared as a literal. */
function declaredLiteral(source: string, name: string): string | null {
  const match = new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*(['"\`])([^'"\`]*)\\1`).exec(source);
  return match ? match[2] : null;
}

describe('models bucket mount — one declaration', () => {
  it('the contract values are the ones every serving pod uses', () => {
    expect(TYPES_MOUNT).toBe('/mnt/models-bucket');
    expect(TYPES_BUCKET).toBe('hope-models');
  });

  it('the gateway re-export equals @arcaai/types', () => {
    expect(GATEWAY_MOUNT).toBe(TYPES_MOUNT);
    expect(GATEWAY_BUCKET).toBe(TYPES_BUCKET);
    expect(deriveLocalPath('x/')).toBe(`${TYPES_MOUNT}/x/`);
  });

  it('the console, IF it declares its own literal, declares the same value', () => {
    const source = readFileSync(CONSOLE_MODEL_META, 'utf8');
    for (const [name, expected] of [
      ['HOPE_MODELS_MOUNT', TYPES_MOUNT],
      ['HOPE_MODELS_BUCKET', TYPES_BUCKET],
    ] as const) {
      const literal = declaredLiteral(source, name);
      if (literal !== null) expect(literal, `${name} in model-meta.ts`).toBe(expected);
    }
  });
});

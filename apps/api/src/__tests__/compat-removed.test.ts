import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * TASK-1004 — the v1 compat surface (`stt-compat`, `text-compat`) was removed
 * outright: zero requests in the 10 days measured before removal, no
 * in-repo consumers. This pins the removal so it cannot silently regress —
 * a future re-add of either module, its registration, its prefix exclusion,
 * or a `api/stt`/`api/smr` route anywhere in the tree fails this suite.
 */

const SRC = join(__dirname, '..');
const MODULES_DIR = join(SRC, 'modules');

function readSrc(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf-8');
}

/** Recursively list every `.controller.ts` file under `modules/`. */
function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listControllerFiles(full));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('compat surface removed (TASK-1004)', () => {
  it('the stt-compat and text-compat module directories no longer exist', () => {
    expect(existsSync(join(MODULES_DIR, 'stt-compat'))).toBe(false);
    expect(existsSync(join(MODULES_DIR, 'text-compat'))).toBe(false);
  });

  it('app.module.ts registers no compat module', () => {
    const source = readSrc('app.module.ts');
    expect(source).not.toMatch(/TextCompatModule|SttCompatModule/);
    expect(source).not.toMatch(/stt-compat|text-compat/);
  });

  it('global-prefix.config.ts excludes only /metrics — no compat prefix exclusion survives', () => {
    const source = readSrc('global-prefix.config.ts');
    expect(source).toContain("'/metrics'");
    expect(source).not.toMatch(/api\/smr|api\/stt/);
  });

  it('no controller anywhere in apps/api declares an api/stt or api/smr route', () => {
    const offenders: string[] = [];
    for (const file of listControllerFiles(MODULES_DIR)) {
      const source = readFileSync(file, 'utf-8');
      const match = source.match(/@Controller\(\s*['"](.+?)['"]\s*\)/);
      if (match && /^api\/(stt|smr)\b/.test(match[1])) {
        offenders.push(`${file}: @Controller('${match[1]}')`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no WebSocket gateway anywhere in apps/api binds the frozen /stt path', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(MODULES_DIR)) {
      const dir = join(MODULES_DIR, entry);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.gateway.ts')) continue;
        const source = readFileSync(join(dir, file), 'utf-8');
        if (/@WebSocketGateway\(\s*\{\s*path:\s*['"]\/stt['"]/.test(source)) {
          offenders.push(join(dir, file));
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

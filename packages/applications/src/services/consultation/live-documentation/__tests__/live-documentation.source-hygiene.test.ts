/**
 * Source-hygiene guard: `live-documentation.service.ts` must never contain a raw
 * NUL byte (0x00). A literal NUL in the source (as opposed to the two-character
 * escape sequence `\0`) makes common tooling — notably ripgrep — treat the file
 * as binary and silently skip it on every `rg` search, hiding the file from
 * grep-based code search/review across the whole codebase.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('live-documentation.service.ts source hygiene', () => {
  it('contains no raw NUL byte', () => {
    const filePath = join(__dirname, '..', 'live-documentation.service.ts');
    const raw = readFileSync(filePath);

    expect(raw.includes(0)).toBe(false);
  });
});

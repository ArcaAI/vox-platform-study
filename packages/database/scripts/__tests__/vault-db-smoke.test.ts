// vault-db-smoke argument parser.
//
// Only the pure parseArgs() helper is unit-tested. The end-to-end
// script requires a live Vault + PG and is exercised manually during
// staging (see Task 5.9 soak document).

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../vault-db-smoke';

describe('vault-db-smoke parseArgs', () => {
  it('defaults role to hope-app-role when no flag is provided', () => {
    expect(parseArgs(['node', 'script'])).toEqual({ role: 'hope-app-role' });
  });

  it('honors --role=<name>', () => {
    expect(parseArgs(['node', 'script', '--role=alt-role'])).toEqual({ role: 'alt-role' });
  });

  it('ignores unknown flags', () => {
    expect(parseArgs(['node', 'script', '--unknown=value', '--role=keep-me'])).toEqual({
      role: 'keep-me',
    });
  });
});

/**
 * @Secret decorator contract pin.
 *
 * Verifies the decorator registers field names on a prototype-keyed
 * metadata bag and that getSecretFields() returns them. Lives in the
 * applications package to confirm the re-export shim works end-to-end.
 */

import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { Secret, getSecretFields, SECRET_FIELDS_KEY } from '../secret.decorator';

class Sample {
  @Secret() value!: string;
  @Secret() defaultValue?: string;
  id!: string;
  key!: string;
}

describe('@Secret decorator (Phase 0 Item 4)', () => {
  it('registers the decorated fields under SECRET_FIELDS_KEY', () => {
    const fields = Reflect.getMetadata(SECRET_FIELDS_KEY, Sample.prototype);
    expect(new Set(fields)).toEqual(new Set(['value', 'defaultValue']));
  });

  it('getSecretFields returns the same set', () => {
    expect(new Set(getSecretFields(Sample.prototype))).toEqual(
      new Set(['value', 'defaultValue']),
    );
  });

  it('getSecretFields returns [] for a class with no decorations', () => {
    class Plain {
      id!: string;
    }
    expect(getSecretFields(Plain.prototype)).toEqual([]);
  });
});

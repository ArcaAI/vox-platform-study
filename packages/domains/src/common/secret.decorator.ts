import 'reflect-metadata';

/**
 * Phase 0 Item 4 (TASK-302 Stream A) — field-level metadata marker.
 *
 * Apply `@Secret()` to an entity property whose value MUST be redacted
 * before crossing any audit-log boundary. The audit serializer
 * (services/tenant/scrubbing.ts) reads this metadata via
 * `getSecretFields(prototype)` and replaces decorated keys with
 * '[REDACTED]' when the source row carries `locked === true`.
 *
 * The decorator lives in `@arcaai/domains` (not `@arcaai/applications`)
 * because applications already depends on domains; placing it here
 * keeps the dependency graph one-directional.
 *
 * Stream B Phase 4 will extend this metadata to drive envelope
 * encryption on persistence — the contract here is intentionally
 * decoupled so both streams can evolve independently.
 */
export const SECRET_FIELDS_KEY = Symbol('phase-0-item-4:secret-fields');

export function Secret(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const existing: Array<string | symbol> =
      Reflect.getMetadata(SECRET_FIELDS_KEY, target) ?? [];
    if (!existing.includes(propertyKey)) {
      Reflect.defineMetadata(SECRET_FIELDS_KEY, [...existing, propertyKey], target);
    }
  };
}

export function getSecretFields(prototype: object): Array<string> {
  const fields: Array<string | symbol> =
    Reflect.getMetadata(SECRET_FIELDS_KEY, prototype) ?? [];
  return fields.filter((f): f is string => typeof f === 'string');
}

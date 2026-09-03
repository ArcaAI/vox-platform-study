/**
 * DELIBERATE COPY of the canonical-JSON algorithm at
 * `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:346`.
 * This package must not depend on `@arcaai/applications` — the seed in
 * `packages/database` needs the compiler and must not pull in the applications layer), so the
 * algorithm is duplicated rather than imported. The header there says the same thing about
 * ITS duplication of an idea; a test in this package (`__tests__/canonical-json.test.ts`, and
 * see also `packages/applications/.../context-schema-definition.test.ts`) asserts
 * byte-equality against the applications-layer function on a shared fixture corpus so the two
 * copies cannot drift silently — see "the cross-language duplication
 * must not add to".
 *
 * Object keys SORTED, array order PRESERVED: key order is a formatting accident and must not
 * mint a new checksum; array order is authored intent (edge/port ordering) and must
 * (`department-agent.prisma:177-180`).
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

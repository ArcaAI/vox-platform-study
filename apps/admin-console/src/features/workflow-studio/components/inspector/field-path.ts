/**
* Dot-path get/set over a node's `config` object — matches `schema-form.ts`'s
 * `path`/`${parentPath}.${key}` convention. Pure, no React import, so it is
 *  unit-testable in isolation. 
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAtPath(config: Record<string, unknown>, path: string): unknown {
  if (path === '') return config;
  return path.split('.').reduce<unknown>((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), config);
}

/** Immutable set — returns a NEW config object with `value` written at `path`, creating
 *  intermediate objects as needed. Never mutates the input. */
export function setAtPath(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (path === '') return isPlainObject(value) ? value : config;
  const keys = path.split('.');
  const [head, ...rest] = keys;
  const existing = config[head];
  if (rest.length === 0) {
    return { ...config, [head]: value };
  }
  const nested = isPlainObject(existing) ? existing : {};
  return { ...config, [head]: setAtPath(nested, rest.join('.'), value) };
}

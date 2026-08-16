/** A finding before the dispatcher (`index.ts`) stamps `ruleId`/`severity`/`ruleClass` onto it. */
export interface RawFinding {
  nodeId: string | null;
  message: string;
  path?: string;
  edgeId?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

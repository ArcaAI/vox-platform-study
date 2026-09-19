/**
 * Environment utility functions for the logging service
 */

export function getEnvString(key: string, defaultValue?: string): string | undefined {
  const value = process.env[key];
  return value !== undefined ? value : defaultValue;
}

export function getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;

  return value.toLowerCase() === 'true' || value === '1';
}

export function getEnvNumber(key: string, defaultValue?: number): number | undefined {
  const value = process.env[key];
  if (value === undefined) return defaultValue;

  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Is this process writing to a terminal a person is looking at?
 *
 * The question the console transport actually needs to answer. `NODE_ENV`
 * cannot answer it: `hope-v2-dev` runs the gateway with
 * `NODE_ENV=development` inside a container whose stdout is a pipe into
 * Alloy and then Loki, where ANSI escapes and a pretty prefix are not
 * "developer friendly", they are unparseable.
 *
 * `isTTY` is undefined on a pipe and `true` on an attached terminal, which is
 * exactly the distinction wanted. Kept next to `isDevelopment` rather than
 * replacing it: other callers legitimately ask about the environment.
 */
export function isHumanReadableStdout(): boolean {
  return process.stdout.isTTY === true;
}

export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

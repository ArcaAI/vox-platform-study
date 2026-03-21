/**
 * Converts a string to snake_case
 * @param str The string to convert
 * @returns The snake-cased string
 */
export function toSnakeCase(str: string): string {
  // Handle empty or null strings
  if (!str) return '';

  // Handle camelCase or PascalCase conversion
  const fromCamelCase = str.replace(/([a-z])([A-Z])/g, '$1_$2');

  // Replace non-alphanumeric with underscores and convert to lowercase
  return fromCamelCase
    .replace(/[^\w\s]/g, '_')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export default toSnakeCase;
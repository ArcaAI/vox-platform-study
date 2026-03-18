/**
 * Converts a string to camel case
 * @param str The string to convert
 * @returns The camel-cased string, ex: "user_id" -> "userId"
 */
export function toCamelCase(str: string): string {
  // Handle empty or null strings
  if (!str) return '';

  // Remove non-alphanumeric characters and replace with spaces
  const cleanStr = str.replace(/[^\w\s]/g, ' ');

  // Split by whitespace, capitalize each word (except first), and join them
  return cleanStr
    .split(/[\s_-]+/)
    .map((word, index) => {
      if (!word) return '';
      return index === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

export default toCamelCase;
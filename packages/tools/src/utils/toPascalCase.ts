/**
 * Converts a string to Pascal case
 * @param str The string to convert
 * @returns The Pascal-cased string, ex: "user_id" -> "UserId"
 */
export function toPascalCase(str: string): string {
  // Handle empty or null strings
  if (!str) return '';

  // Remove non-alphanumeric characters and replace with spaces
  const cleanStr = str.replace(/[^\w\s]/g, ' ');

  // Split by whitespace, capitalize each word, and join them together
  return cleanStr
    .split(/[\s_-]+/)
    .map((word) => {
      if (!word) return '';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

export default toPascalCase;

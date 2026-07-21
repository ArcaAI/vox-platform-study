/**
 * @arcaai/med-ner - HTML Escape Utility
 *
 * Clinical text routinely contains characters that are unsafe to inject
 * directly into HTML (`<50%`, `pH>7`, `T<38.5°C`, drug brand names with
 * apostrophes, etc.). Any helper in this package that renders untrusted
 * text into an HTML string MUST funnel that text through {@link escapeHtml}
 * to prevent XSS.
 */

/**
 * Escape the five HTML-sensitive characters in a string.
 *
 * The order matters: `&` is escaped first so subsequent replacements do
 * not double-encode their `&` prefixes.
 *
 * @param value - The raw text to escape.
 * @returns The HTML-safe equivalent.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

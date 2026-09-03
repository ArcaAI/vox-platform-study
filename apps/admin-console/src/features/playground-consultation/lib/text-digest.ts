/**
 * SHA-256 of a note's text, for `corrections.textSha256` gate.
 *
 * The correction proposals index BYTE OFFSETS into one exact revision of the text. If the note
 * has moved since, those offsets address characters that are no longer there, and applying a
 * proposal would splice a drug name or a dose over the wrong span. The contract therefore pins
 * the source revision by digest, and the console must refuse to apply anything when its own
 * text does not hash to that value.
 *
 * `crypto.subtle` is a WinterTC global — present in every browser this console supports and in
 * the Node/happy-dom test environments.
 */

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

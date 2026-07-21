/**
 * @arcaai/vox - SecureStorage (SEC-02)
 *
 * Encrypted localStorage wrapper using the Web Crypto API.
 * Protects medical data at rest in the browser with AES-GCM encryption.
 *
 * Usage:
 * ```typescript
 * const storage = await SecureStorage.create('user-passphrase');
 * await storage.setItem('arcaai-preferences', JSON.stringify(prefs));
 * const prefs = await storage.getItem('arcaai-preferences');
 * ```
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_ITERATIONS = 100_000;

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KEY_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class SecureStorage {
  private key: CryptoKey;
  private salt: Uint8Array<ArrayBuffer>;

  private constructor(key: CryptoKey, salt: Uint8Array<ArrayBuffer>) {
    this.key = key;
    this.salt = salt;
  }

  static async create(passphrase: string): Promise<SecureStorage> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKey(passphrase, salt);
    return new SecureStorage(key, salt);
  }

  async setItem(key: string, value: string): Promise<void> {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, this.key, encoder.encode(value));

    const payload = JSON.stringify({
      s: toBase64(this.salt),
      iv: toBase64(iv),
      d: toBase64(encrypted),
    });

    localStorage.setItem(key, payload);
  }

  async getItem(key: string): Promise<string | null> {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    try {
      const { iv, d } = JSON.parse(raw);

      const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv: fromBase64(iv) }, this.key, fromBase64(d));

      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  removeItem(key: string): void {
    localStorage.removeItem(key);
  }

  /**
   * Cross-session helpers for caches keyed by a stable
   * passphrase (e.g. `vox-vp-${userId}-${tenantId}`). `create()` uses a
   * random salt per instance, so a SecureStorage created in one session
   * cannot decrypt items written in another. These helpers persist the
   * salt with the payload and re-derive the key on read.
   */
  static async getItemWithPassphrase(storageKey: string, passphrase: string): Promise<string | null> {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      const { s, iv, d } = JSON.parse(raw) as { s: string; iv: string; d: string };
      if (!s || !iv || !d) return null;
      const salt = fromBase64(s);
      const key = await deriveKey(passphrase, salt);
      const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv: fromBase64(iv) }, key, fromBase64(d));
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  static async setItemWithPassphrase(storageKey: string, passphrase: string, value: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKey(passphrase, salt);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, new TextEncoder().encode(value));
    const payload = JSON.stringify({
      s: toBase64(salt),
      iv: toBase64(iv),
      d: toBase64(encrypted),
    });
    localStorage.setItem(storageKey, payload);
  }
}

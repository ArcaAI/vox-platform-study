// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// Highlight (W3C quote selectors `exact`/`prefix`/`suffix` + free-text `note`).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration
// merging + prototype patching). All four fields share ONE `keyVersion`
// column; shared Buffer/ciphertext primitives live in
// common/field-encryption.ts and default to the `hope-phi` Transit key.
// Plaintext columns are retained for the dual-read soak.

import { HighlightRepository } from './HighlightRepository';
import { HighlightEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link HighlightRepository.decryptFieldsFromEntity}. */
export interface HighlightPlaintext {
  exact: string | null;
  prefix: string | null;
  suffix: string | null;
  note: string | null;
}

declare module './HighlightRepository' {
  interface HighlightRepository {
    /**
     * Encrypt every populated quote-selector / note field via Vault Transit
     * (hope-phi), storing ciphertext in the matching `encrypted*` column and
     * recording the Transit key version in the shared `keyVersion`. Mutates the
     * entity in place. No-op per field when empty/null. Plaintext retained for
     * the dual-read soak.
     */
    encryptFieldsIntoEntity(
      this: HighlightRepository,
      entity: HighlightEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /** Decrypt all ciphertext columns, each falling back to its plaintext column. */
    decryptFieldsFromEntity(
      this: HighlightRepository,
      entity: HighlightEntity,
      secrets: SecretsServiceLike,
    ): Promise<HighlightPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: HighlightRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: HighlightEntity; plaintext: HighlightPlaintext }>;
  }
}

HighlightRepository.prototype.encryptFieldsIntoEntity = async function (
  this: HighlightRepository,
  entity: HighlightEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const exact = await encryptStringToCiphertext(secrets, entity.exact);
  if (exact) {
    entity.encryptedExact = exact.ciphertext;
    keyVersion = exact.keyVersion;
  }

  const prefix = await encryptStringToCiphertext(secrets, entity.prefix);
  if (prefix) {
    entity.encryptedPrefix = prefix.ciphertext;
    keyVersion = prefix.keyVersion;
  }

  const suffix = await encryptStringToCiphertext(secrets, entity.suffix);
  if (suffix) {
    entity.encryptedSuffix = suffix.ciphertext;
    keyVersion = suffix.keyVersion;
  }

  const note = await encryptStringToCiphertext(secrets, entity.note);
  if (note) {
    entity.encryptedNote = note.ciphertext;
    keyVersion = note.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

HighlightRepository.prototype.decryptFieldsFromEntity = async function (
  this: HighlightRepository,
  entity: HighlightEntity,
  secrets: SecretsServiceLike,
): Promise<HighlightPlaintext> {
  const exact = await decryptCiphertextToString(secrets, entity.encryptedExact);
  const prefix = await decryptCiphertextToString(secrets, entity.encryptedPrefix);
  const suffix = await decryptCiphertextToString(secrets, entity.encryptedSuffix);
  const note = await decryptCiphertextToString(secrets, entity.encryptedNote);
  return {
    exact: exact !== null ? exact : (entity.exact ?? null),
    prefix: prefix !== null ? prefix : (entity.prefix ?? null),
    suffix: suffix !== null ? suffix : (entity.suffix ?? null),
    note: note !== null ? note : (entity.note ?? null),
  };
};

HighlightRepository.prototype.findByIdWithDecryptedFields = async function (
  this: HighlightRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: HighlightEntity; plaintext: HighlightPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};

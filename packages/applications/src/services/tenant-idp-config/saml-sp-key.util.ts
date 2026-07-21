/**
 * SAML SP key-pair generation.
 *
 * Mints the RSA key pair + self-signed X.509 certificate a tenant's SAML SP
 * config uses to sign AuthnRequests and (optionally) decrypt assertions
 * . Wraps the maintained `selfsigned` library rather than
 * hand-rolling X.509 — the IdP-side signature-verification path has its own
 * tampered/expired/replayed test matrix against `@node-saml/node-saml`; this
 * is only SP-side key issuance, called from `TenantIdpConfigService.create`.
 */

import { generate as generateSelfSignedCertificate } from 'selfsigned';

export interface SamlSpKeyPair {
  privateKeyPem: string;
  certificatePem: string;
}

export interface GenerateSamlSpKeyPairOptions {
  /** Certificate subject/issuer common name. @default 'HOPE SAML SP' */
  commonName?: string;
  /** Certificate validity window in days. @default 1095 (3 years) */
  validityDays?: number;
  /** RSA key size in bits. @default 2048 */
  keySizeBits?: number;
}

const DEFAULT_COMMON_NAME = 'HOPE SAML SP';
const DEFAULT_VALIDITY_DAYS = 1095;
const DEFAULT_KEY_SIZE_BITS = 2048;
const SIGNATURE_ALGORITHM = 'sha256';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function generateSamlSpKeyPair(options: GenerateSamlSpKeyPairOptions = {}): Promise<SamlSpKeyPair> {
  const commonName = options.commonName ?? DEFAULT_COMMON_NAME;
  const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  const keySize = options.keySizeBits ?? DEFAULT_KEY_SIZE_BITS;

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + validityDays * MS_PER_DAY);

  const result = await generateSelfSignedCertificate([{ name: 'commonName', value: commonName }], {
    keySize,
    algorithm: SIGNATURE_ALGORITHM,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    ],
  });

  return { privateKeyPem: result.private, certificatePem: result.cert };
}

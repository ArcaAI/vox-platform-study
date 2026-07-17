/**
 * TASK-499 P1 — SAML SP key-pair generation unit tests.
 *
 * `generateSamlSpKeyPair()` mints the RSA key pair + self-signed certificate a
 * tenant's SAML SP config needs to sign AuthnRequests / decrypt assertions
 * (TASK-499 D2/D5). Pure, dependency-light (wraps the maintained `selfsigned`
 * library — no hand-rolled X.509), so it is unit-testable without any live
 * `TenantIdentityProvider` row.
 */

import { createPrivateKey, X509Certificate } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generateSamlSpKeyPair } from '../saml-sp-key.util';

describe('generateSamlSpKeyPair', () => {
  it('returns a private key and a self-signed certificate whose public keys match', async () => {
    const { privateKeyPem, certificatePem } = await generateSamlSpKeyPair();

    const privateKey = createPrivateKey(privateKeyPem);
    const cert = new X509Certificate(certificatePem);

    expect(cert.checkPrivateKey(privateKey)).toBe(true);
  });

  it('produces a certificate that is self-signed (verifies against its own public key)', async () => {
    const { certificatePem } = await generateSamlSpKeyPair();
    const cert = new X509Certificate(certificatePem);

    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it('defaults to a 2048-bit RSA key signed with sha256', async () => {
    const { privateKeyPem, certificatePem } = await generateSamlSpKeyPair();

    const privateKey = createPrivateKey(privateKeyPem);
    expect(privateKey.asymmetricKeyType).toBe('rsa');
    expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);

    const cert = new X509Certificate(certificatePem);
    const signatureAlgorithm = (cert as { signatureAlgorithm?: string }).signatureAlgorithm;
    if (signatureAlgorithm !== undefined) {
      expect(signatureAlgorithm).toBe('sha256WithRSAEncryption');
    } else {
      // Node < 23 has no X509Certificate.signatureAlgorithm (the original
      // assertion compared against undefined and could never pass) — assert
      // the sha256WithRSAEncryption OID (1.2.840.113549.1.1.11) in the DER.
      const sha256RsaOidDer = Buffer.from('06092a864886f70d01010b', 'hex');
      expect(cert.raw.includes(sha256RsaOidDer)).toBe(true);
    }
  });

  it('honors a custom key size', async () => {
    const { privateKeyPem } = await generateSamlSpKeyPair({ keySizeBits: 3072 });
    const privateKey = createPrivateKey(privateKeyPem);

    expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
  });

  it('defaults the certificate common name to the HOPE SP identity', async () => {
    const { certificatePem } = await generateSamlSpKeyPair();
    const cert = new X509Certificate(certificatePem);

    expect(cert.subject).toContain('CN=HOPE SAML SP');
    expect(cert.issuer).toBe(cert.subject);
  });

  it('stamps a given common name into the certificate subject', async () => {
    const { certificatePem } = await generateSamlSpKeyPair({ commonName: 'Acme Tenant SAML SP' });
    const cert = new X509Certificate(certificatePem);

    expect(cert.subject).toContain('CN=Acme Tenant SAML SP');
  });

  it('honors a custom validity window', async () => {
    const { certificatePem } = await generateSamlSpKeyPair({ validityDays: 30 });
    const cert = new X509Certificate(certificatePem);

    const spanMs = cert.validToDate.getTime() - cert.validFromDate.getTime();
    const spanDays = spanMs / (24 * 60 * 60 * 1000);

    expect(spanDays).toBeGreaterThan(29.9);
    expect(spanDays).toBeLessThan(30.1);
  });

  it('defaults to a multi-year validity window', async () => {
    const { certificatePem } = await generateSamlSpKeyPair();
    const cert = new X509Certificate(certificatePem);

    const spanDays = (cert.validToDate.getTime() - cert.validFromDate.getTime()) / (24 * 60 * 60 * 1000);

    expect(spanDays).toBeGreaterThan(365 * 2);
  });

  it('generates distinct key material on every call (no shared/static keys)', async () => {
    const first = await generateSamlSpKeyPair();
    const second = await generateSamlSpKeyPair();

    expect(first.privateKeyPem).not.toBe(second.privateKeyPem);
    expect(first.certificatePem).not.toBe(second.certificatePem);
  });
});

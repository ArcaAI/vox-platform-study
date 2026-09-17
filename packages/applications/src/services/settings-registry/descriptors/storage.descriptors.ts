// Storage descriptors — the platform
// object-store configuration moves out of deploy-time env into
// admin-managed data.
//
// Physical home: the SYSTEM-tenant `TenantStorageConfig` row
// (`tenantId = SYSTEM_TENANT_ID`, `bucketId = NULL`). Non-secret fields are
// `db-config`; the MinIO/S3 key PAIR is NOT one of them — it lives in Vault
// kv-v2 at `platform/storage/minio` and is referenced by `credentialsRef`
// (per-tenant/platform secrets never sit in a DB column).
//
// Governance: every key here is SUPER_ADMIN-ONLY (`globalOnly: true`,
// `editableBy: 'all'`), enforced imperatively by
// `TenantStorageConfigService.assertSuperAdmin` — the permission decorators
// cannot express "super admins only" (rule 05). `maxScope: 'system'` says the
// value may be set at the SYSTEM scope and nowhere deeper: a tenant tunes its
// own backend through its OWN `TenantStorageConfig` row, not by overriding the
// platform default.
//
// The `MINIO_*` env keys stay declared for one release as the documented
// BOOTSTRAP fallback used before the SYSTEM row exists (first boot / pre-seed);
// they are registered here as `env` tier so the catalog shows the whole story.

import { SettingDescriptor } from '../registry.types';

export const STORAGE_SETTINGS: SettingDescriptor[] = [
  {
    key: 'storage.platformDefault.provider',
    tier: 'db-config',
    // stt selects its object-store backend from this; its `STORAGE_PROVIDER`
    // env field is closed structurally (`stt/core/control_plane.py`), so this
    // is the only surface that sets it.
    //
    // NOT declared for harness: the claim-check backend is chosen by
    // `HARNESS_CLAIM_CHECK_STORE` (the in-memory dev fake vs the real
    // S3-compatible store), which is a different axis from which cloud vendor
    // the platform's object storage is. Harness consumes the LOCATION keys
    // below and nothing else — a `consumedBy` nobody reads is the dead-knob
    // class of unused consumedBy entries to remove.
    consumedBy: ['stt'],
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'Platform storage provider',
    description: 'Object-store backend every tenant falls back to: minio | aws_s3 | azure_blob.',
    default: 'minio',
  },
  {
    key: 'storage.platformDefault.endpoint',
    tier: 'db-config',
    // harness's claim-check store IS platform object storage; it reads the
    // location from this cascade instead of a parallel HARNESS_CLAIM_CHECK_* block.
    consumedBy: ['harness'],
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'Platform storage endpoint',
    description: 'S3/MinIO endpoint URL for the platform default. Empty means the SDK default (real AWS S3).',
  },
  {
    // TASK-984 — the ORIGIN presigned download URLs are signed for. SigV4 signs
    // the host, so a URL signed for the in-cluster endpoint cannot be rewritten
    // for a browser afterwards; it must be signed for the address the browser
    // uses. Deliberately NO env or AppSettings fallback (owner, 2026-09-17): the
    // platform admin sets it on the SYSTEM row, and absent means "sign with the
    // endpoint", which is already right wherever the endpoint is reachable.
    // No `consumedBy`: only the gateway presigns.
    key: 'storage.platformDefault.publicEndpoint',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    failMode: 'open-to-default',
    label: 'Public download endpoint',
    description:
      'Origin browsers use to download stored files (e.g. https://admin.example.com). Presigned URLs are signed for it. ' +
      'Empty means sign with the storage endpoint. S3/MinIO only.',
  },
  {
    key: 'storage.platformDefault.region',
    tier: 'db-config',
    consumedBy: ['harness'],
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'Platform storage region',
    description: 'S3 region used by the platform default.',
    default: 'us-east-1',
  },
  {
    key: 'storage.platformDefault.forcePathStyle',
    tier: 'db-config',
    // `consumedBy: ['harness']` was declared here until TASK-872. The KEY stays
    // — the gateway's own storage resolver reads it — but the harness does not:
    // it never parses this value off the effective-config pull route. A
    // `consumedBy` entry is a promise that the named service reads the key on
    // that route, and the governance test only checks that such a key is
    // RESOLVABLE, not that anyone resolves it.
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'Force path-style URLs',
    description: 'Required for MinIO; leave on unless the backend is real AWS S3 with virtual-hosted addressing.',
    default: true,
  },
  {
    key: 'storage.platformDefault.containerPrefix',
    tier: 'db-config',
    // Applied by harness to its claim-check bucket name, so an operator can
    // namespace every physical bucket in one place.
    consumedBy: ['harness'],
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'Platform bucket/container prefix',
    description: 'Optional namespace prefix applied to physical bucket/container names.',
  },
  {
    key: 'storage.platformDefault.credentials',
    tier: 'vault-kv',
    dataType: 'secret',
    sensitivity: 'secret',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    category: 'Credentials',
    // Secret: never silently substitute another value (`register()` enforces
    // `secret` => `closed`).
    failMode: 'closed',
    label: 'Platform storage credentials (Vault kv-v2)',
    description:
      "Operator-set JSON `{ accessKeyId, secretAccessKey }` at the Vault path recorded in the SYSTEM row's `credentialsRef` " +
      '(default `platform/storage/minio`). Never stored in the database and never returned by any API.',
    default: 'platform/storage/minio',
  },
  {
    // Key is `minio.endpoint`, not `storage.bootstrap.*`: the env-name mapping is a
    // MECHANICAL 1:1 with the live variable name, which is `MINIO_ENDPOINT`. A
    // `storage.bootstrap.` prefix would derive `STORAGE_BOOTSTRAP_MINIO_ENDPOINT`
    // and break the mapping the registry test enforces.
    key: 'minio.endpoint',
    tier: 'env',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    // `env` tier has no write path, so it declares the `none` sentinel rather than
    // a CASL subject — naming one would advertise an editor that does not exist
    // (env-tier invariant: env ⇒ editableBy 'none'). `globalOnly` is omitted for the
    // same reason: there is nothing to gate. The ADMIN-editable counterpart of this
    // value is `storage.platformDefault.endpoint` above.
    editableBy: 'none',
    category: 'Storage',
    // Tuning: an absent value falls back to the descriptor default, then the env
    // bootstrap tier — first boot must not be blocked on the SYSTEM row existing.
    failMode: 'open-to-default',
    label: 'MINIO_ENDPOINT (bootstrap fallback)',
    description:
      'Deploy-time fallback used ONLY before the SYSTEM storage row exists (first boot / pre-seed). Scheduled for removal one ' +
      'release after the SYSTEM row ships; a WARN is logged whenever it is the tier that supplied the value.',
  },
  {
    // Sibling of `minio.endpoint` above, in the same shape and the same tier:
    // key `minio.certCheck` maps mechanically to `MINIO_CERT_CHECK`, which is
    // the variable `apps/stt` already reads (its `Settings` carries no
    // env_prefix) and which `turbo.json#globalEnv` already declares.
    //
    // ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling 2026-08-30).
    // Absent ⇒ FALSE ⇒ certificates are NOT verified. There is no private CA,
    // MinIO serves HTTPS on :9000 with a certificate nothing here can chain to
    // a trusted root, and MinIO authentication is a service account (access key
    // + secret) rather than the certificate — so "verify" would fail every
    // object-store call closed. PHI hardening is explicitly de-prioritised for
    // now; grep `MINIO_CERT_CHECK` for every consumer to revert when a CA lands.
    //
    // ENV-TIER, and correctly so: a TLS trust decision is made when the client
    // socket is built, which is process start — it is the same bootstrap floor
    // as `minio.endpoint`, not something an admin flips at runtime.
    key: 'minio.certCheck',
    tier: 'env',
    // No `consumedBy`, exactly like `minio.endpoint`: env-tier keys have no
    // resolver lane, so declaring one would promise a value on the
    // effective-config pull route that would be served as `null` forever
    // (`consumed-by-resolvability.governance.test.ts`). Each process reads
    // `MINIO_CERT_CHECK` from its own environment — apps/api, apps/stt and the
    // harness worker all do.
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    // env tier ⇒ no write path (see `minio.endpoint` above).
    editableBy: 'none',
    category: 'Storage',
    // Tuning, not selection: an absent value means "the deployed posture",
    // which is the default below rather than a hard failure.
    failMode: 'open-to-default',
    label: 'MINIO_CERT_CHECK (verify object-store TLS certificates)',
    description:
      'Verify the S3/MinIO endpoint TLS certificate. Defaults to FALSE: MinIO keeps HTTPS, but the platform has no CA to ' +
      'validate its certificate against and authenticates with a service-account key pair instead. Set to `true` once a ' +
      'trusted certificate chain exists.',
    default: false,
  },
];

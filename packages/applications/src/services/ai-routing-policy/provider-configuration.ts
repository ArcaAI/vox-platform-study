/**
 * TASK-844 — the PROVIDER CONFIGURATION as a portable, secret-free artifact.
 *
 * Two jobs, both deliberately PURE so they can be tested without a database:
 *
 *  1. **Row → candidate projection.** The re-grain moved the ordered chain out
 *     of `candidatesJson` and onto the rows themselves, but the §3A.4 gates
 *     (`routing-gates.ts`) still reason over `RoutingCandidate`. Projecting here
 *     means the gates did not change at all — the same residency / BAA /
 *     cross-funding rules apply, they just read row scalars now.
 *
 *  2. **Export / import.** An administrator can lift a set of configurations out
 *     of one tenant as JSON and land them in another. The artifact must be
 *     useful (endpoints, model bindings, ordering, the election) and must carry
 *     NO recoverable credential material.
 *
 * ## The secret rule, and why it is stricter than the brief asked for
 *
 * The ticket brief suggested emitting "a masked hint (e.g. last 4)". **This
 * module deliberately emits no characters of any credential at all**, and that
 * is a considered deviation, not an oversight:
 *
 *   * the credential is Vault-Transit CIPHERTEXT in `encryptedApiKey`, so
 *     producing a last-4 would require DECRYPTING a live key on an export path
 *     whose entire purpose is to not handle key material; and
 *   * a last-4 is not a mask, it is a partial disclosure. Four known characters
 *     shorten a brute force, and vendor keys carry structured prefixes, so the
 *     tail is often the highest-entropy part. On a PHI platform that is a
 *     credential leak with a friendly name.
 *
 * What an operator actually needs to re-supply the secret is *which* secret it
 * was, not what it looked like. So the artifact carries a `credentialRef`
 * LOCATOR — `(service, provider, keyVersion)` — plus `hasCredential`, which
 * together say "this configuration needs the Azure key you know as v3" without
 * revealing one byte of it.
 *
 * `assertNoSecretMaterial` is the runtime expression of that rule and is
 * asserted by test, not left to review.
 */

import { RoutingCandidate } from './routing-policy.contract';

/** The columns of an `AiRoutingPolicy` row this module reads. */
export interface ProviderConfigurationRow {
  id: string;
  tenantId: string;
  taskKey: string;
  taskKind?: string | null;
  displayName?: string | null;
  providerConnectionId?: string | null;
  modelId?: string | null;
  modelRef?: string | null;
  isDefault: boolean;
  enabled: boolean;
  residency?: string | null;
  baaCovered?: boolean | null;
  priority: number;
  policyVersion: number;
}

/** What the caller must supply so a row can name a provider and a model in words. */
export interface ConfigurationRefs {
  /** `AiProviderConnection.provider` for `providerConnectionId`, if it resolved. */
  connectionProvider?: string | null;
  /** `AiProviderConnection.service` for `providerConnectionId`, if it resolved. */
  connectionService?: string | null;
  /** `AiModel.slug` for `modelId`, if it resolved. */
  modelSlug?: string | null;
}

/**
 * Project one row onto the `RoutingCandidate` the §3A.4 gates consume.
 *
 * Two fail-closed choices, both matching what `parseCandidates` did with a
 * malformed JSON candidate:
 *
 *   * `baaCovered` NULL becomes `false`. The gate asks "is this hop covered";
 *     an unanswered question is not a yes. Defaulting TRUE would let an
 *     unreviewed vendor take PHI on a fallback hop.
 *   * `residency` NULL becomes the empty class. The gate compares hop and
 *     primary for EQUALITY, so two unlabelled rows still match each other while
 *     neither matches a labelled one — which is the conservative reading.
 *
 * `connectionRef` is the connection's PROVIDER name rather than its id, because
 * that is what `IProviderConnectionService.resolveConnection` takes, and routing
 * funding must keep flowing through the one cascade that knows the three
 * AiProviderConnection states (absent / enabled+keyed / disabled = veto).
 */
export function rowToCandidate(row: ProviderConfigurationRow, refs: ConfigurationRefs, rank: number): RoutingCandidate {
  return {
    rank,
    weight: 100,
    connectionRef: refs.connectionProvider ?? '',
    model: row.modelRef ?? refs.modelSlug ?? '',
    residency: row.residency ?? '',
    baaCovered: row.baaCovered === true,
    maxTtftMs: null,
  };
}

/** One configuration in an export artifact. Contains NO credential material. */
export interface ExportedProviderConfiguration {
  taskKey: string;
  taskKind: string | null;
  displayName: string | null;
  /** The connection's capability + provider NAME — never its id, which is tenant-local. */
  connection: { service: string; provider: string } | null;
  /** Catalogue model by SLUG — the portable identity across tenants. */
  modelSlug: string | null;
  /** Provider-side model id (Azure deployment, GGUF id) when it differs from the slug. */
  modelRef: string | null;
  isDefault: boolean;
  enabled: boolean;
  residency: string | null;
  baaCovered: boolean | null;
  priority: number;
  /**
   * A LOCATOR for the credential the importing operator must supply. Never the
   * credential, never part of it. `null` when the source configuration had no
   * credentialed connection at all (a self-hosted engine, or an in-process
   * model that is served by no connection).
   */
  credentialRef: string | null;
  /** Whether the SOURCE had a credential, so an import can tell "none needed" from "you must supply one". */
  hasCredential: boolean;
}

export interface ProviderConfigurationExport {
  /** Artifact-format version, so an importer can refuse a shape it does not understand. */
  formatVersion: 1;
  exportedAt: string;
  /** The tenant the configurations were read FROM. Informational — an import targets whatever tenant the operator names. */
  sourceTenantId: string;
  /** Stated in the artifact so nobody has to infer it from the absence of a field. */
  secretsIncluded: false;
  notice: string;
  configurations: ExportedProviderConfiguration[];
}

export const EXPORT_NOTICE =
  'This artifact contains NO credential material. Every configuration that needs a secret carries a `credentialRef` locator ' +
  'naming which credential to supply; the importing operator must supply it out of band. Importing does not, and cannot, ' +
  'restore a key.';

/**
 * Build the credential LOCATOR. Deliberately derived only from non-secret
 * identity — capability, provider name, and the key VERSION counter (an
 * integer the platform assigns, not a fragment of the key).
 */
export function credentialRefFor(
  service: string | null | undefined,
  provider: string | null | undefined,
  keyVersion: number | null | undefined,
): string | null {
  if (!service || !provider) return null;
  return `vault-transit:${service}:${provider}${typeof keyVersion === 'number' ? `:v${keyVersion}` : ''}`;
}

export function toExportedConfiguration(
  row: ProviderConfigurationRow,
  refs: ConfigurationRefs,
  credential: { hasKey: boolean; keyVersion: number | null },
): ExportedProviderConfiguration {
  return {
    taskKey: row.taskKey,
    taskKind: row.taskKind ?? null,
    displayName: row.displayName ?? null,
    connection: refs.connectionProvider && refs.connectionService ? { service: refs.connectionService, provider: refs.connectionProvider } : null,
    modelSlug: refs.modelSlug ?? null,
    modelRef: row.modelRef ?? null,
    isDefault: row.isDefault,
    enabled: row.enabled,
    residency: row.residency ?? null,
    baaCovered: row.baaCovered ?? null,
    priority: row.priority,
    credentialRef: credential.hasKey ? credentialRefFor(refs.connectionService, refs.connectionProvider, credential.keyVersion) : null,
    hasCredential: credential.hasKey,
  };
}

/**
 * Keys that must NEVER appear anywhere in an export artifact, at any depth.
 *
 * This is a DENY-LIST on the serialized shape, checked at runtime rather than
 * trusted from the builder above. The builder is the thing most likely to gain
 * a field in a hurry; a structural assertion catches that, a code review of the
 * builder does not.
 */
const FORBIDDEN_KEYS = ['encryptedapikey', 'apikey', 'api_key', 'secret', 'password', 'token', 'credentials', 'privatekey', 'clientsecret'];

/**
 * Throw if the artifact carries anything that looks like credential material.
 *
 * Walks the whole structure, so it also catches a secret smuggled into a nested
 * object or an array — the shapes a targeted review is worst at.
 *
 * `credentialRef` is explicitly ALLOWED and is the one deliberate exception:
 * it is a locator built from `(service, provider, keyVersion)` by
 * {@link credentialRefFor} and contains no key bytes. It is exempted by NAME so
 * that a future field cannot smuggle a secret past this check by being called
 * something that merely contains "ref".
 */
export function assertNoSecretMaterial(artifact: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    // BEFORE the object branch: `typeof new Uint8Array() === 'object'`, so
    // checking it later lets ciphertext through as an object of numeric keys —
    // which is exactly the shape a leaked `encryptedApiKey` serializes to.
    if (node instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(node))) {
      throw new Error(`Export artifact carries binary data at ${path}. That is ciphertext, and it must never be exported.`);
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
        if (key !== 'credentialRef' && key !== 'hasCredential' && FORBIDDEN_KEYS.includes(normalized)) {
          throw new Error(
            `Export artifact carries a forbidden key '${key}' at ${path}. Provider configurations are exported WITHOUT credential material.`,
          );
        }
        walk(value, `${path}.${key}`);
      }
      return;
    }
  };
  walk(artifact, '$');
}

/**
 * what each provider REQUIRES, declared once and enforced on write.
 *
 * THE DEFECT THIS CLOSES. `provider-extras.ts` made `extraJson` a validated
 * passthrough — it checks the SHAPE of what an operator sends. Nothing checked
 * that what they DIDN'T send was optional. An Azure connection saved with no
 * deployment name is accepted, stored, enabled, and then fails on the first
 * request that resolves it — in a worker, hours later, as a vendor error whose
 * text names nothing an operator can act on. The information needed to refuse
 * it was present at save time, in the console, next to the empty field.
 *
 * THE RULE. Every provider declares the fields a connection must carry in order
 * to be usable. The write path refuses a row that does not, with a message that
 * NAMES the missing field. Two constraints make this safe rather than merely
 * strict:
 *
 * 1. **Keyless stays expressible.** A self-hosted engine (lm-studio, ollama,
 *    llama.cpp) has no vendor account and no key; requiring one would make the
 *    normal case unsayable. `apiKey` is required only where the provider IS a
 *    vendor account. What actually stops a `baseUrl` being mistaken for a
 *    credential is not this table but `toOverrideEntry`, which drops a keyless
 *    row from the fold on BOTH tiers.
 *
 * 2. **DISABLED rows are exempt.** `enabled: false` is the tenant's VETO
 *    (`CONNECTION_ENABLED_SEMANTICS`), and a tenant refusing Azure has no Azure
 *    endpoint, deployment or key to supply. Requiring them would make the
 *    refusal unsayable — and a row that never serves a request cannot fail at
 *    request time, which is the only thing this file exists to prevent. It also
 *    keeps the deliberately blank-and-disabled SYSTEM catalog rows in
 *    `seed/17-ai-provider-connection.ts` legal, which is what they are for: a
 *    placeholder a super admin fills in.
 *
 * WHERE IT IS ENFORCED. In `AiProviderConnectionService.upsertRow`, against the
 * MERGED row — not in the request DTO. Upsert is partial: omitting `apiKey`
 * means "leave the stored key alone", so a DTO-level check would refuse a valid
 * edit that never touched the key. The requirement is a property of the
 * resulting stored row, so it can only be evaluated once that row is known.
 */
import { ProviderService } from './constants';
import { sanitizeProviderExtras } from './provider-extras';

/** A column on the connection row a provider may require. */
export type ProviderRequirementColumn = 'baseUrl' | 'region' | 'apiVersion' | 'deploymentName' | 'apiKey';

/** Operator-facing names for the columns, so a message says what the console labels. */
const COLUMN_LABELS: Record<ProviderRequirementColumn, string> = {
  baseUrl: 'the server or endpoint URL',
  region: 'the vendor region',
  apiVersion: 'the API version',
  deploymentName: 'the deployment name',
  apiKey: 'an API key',
};

/** A required `extraJson` key, optionally with a shape its value must satisfy. */
export interface ProviderExtraRequirement {
  /** The canonical key, exactly as it is stored and forwarded. */
  key: string;
  /** What it is, in operator words. */
  label: string;
  /** Why the value is unusable, or `null` when it is fine. Presence is checked first. */
  validate?: (value: unknown) => string | null;
}

/** Everything one `(service, provider)` pair must carry to be usable. */
export interface ProviderRequirement {
  columns: readonly ProviderRequirementColumn[];
  extras?: readonly ProviderExtraRequirement[];
  /**
   * TASK-932 D-7 — an ENABLED row that carries NO credential material at all is
   * the platform's BUILT-IN default for this provider, and requires nothing.
   *
   * This is the third exemption, and it is a different shape from the other two.
   * `enabled: false` is the VETO (a row that never serves cannot fail at request
   * time); an unlisted pair is UNKNOWN (the table records what is known). This
   * one says: for a platform-managed plane, "blank" is itself a configured
   * state — the weight store falls back to the platform's own storage
   * credentials, and the Hugging Face Hub pulls public repos anonymously (which
   * is exactly what the `absent` outcome means to `apps/stt`'s fetcher).
   *
   * It is all-or-nothing on purpose: the moment an operator supplies ONE part of
   * the credential, every part is required again. A half-filled S3 row is the
   * failure this table exists to refuse — it is neither the built-in default nor
   * a signable request.
   */
  platformDefaultWhenBlank?: boolean;
  /**
   * Why these, in one sentence. A requirement nobody can explain is a
   * requirement nobody can safely remove — and the reasons differ per provider
   * (a vendor account vs. a self-hosted server vs. a hub with no discovery).
   */
  why: string;
}

/**
 * A llama.cpp model reference the resolver can actually act on.
 *
 * An ABSOLUTE filesystem path or an object-store URL, and nothing else. A
 * relative path is refused because the process that resolves it has no defined
 * working directory — it would mean a different file in the server container
 * than in the console operator's head, which is the failure mode "it works on
 * my machine" is made of.
 */
function assertModelPathShape(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string';
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) return null;
  if (/^(s3|https?|file):\/\//.test(trimmed)) return null;
  return 'must be an absolute path (/models/…) or a model URL (s3://…, https://…)';
}

/**
 * The per-provider requirement sets.
 *
 * Keyed `"<service>:<provider>"`. An UNLISTED pair requires nothing — the
 * default is permissive on purpose. This table records what is KNOWN about a
 * provider; inventing a requirement for one nobody has integrated yet would
 * block an operator on a guess, and the write path is not the place to discover
 * a vendor's contract.
 */
export const PROVIDER_REQUIREMENTS: Readonly<Record<string, ProviderRequirement>> = {
  // ── Self-hosted engines: an endpoint, and deliberately no key ──────────────
  'llm:lm-studio': {
    columns: ['baseUrl'],
    why: 'A self-hosted OpenAI-compatible server is reachable only by URL; it has no vendor account, so keyless is its normal state.',
  },
  'llm:ollama': {
    columns: ['baseUrl'],
    why: 'A self-hosted Ollama server is reachable only by URL; it has no vendor account, so keyless is its normal state.',
  },
  'llm:llama-cpp': {
    columns: ['baseUrl'],
    extras: [{ key: 'modelPath', label: 'the model file path or URL', validate: assertModelPathShape }],
    why: 'llama.cpp serves ONE model chosen at load time, so the endpoint alone does not identify what will answer — the weights must be named too, and named unambiguously.',
  },

  // ── Vendor accounts: the fields without which the vendor call cannot be built ──
  'llm:azure': {
    columns: ['baseUrl', 'apiVersion', 'deploymentName', 'apiKey'],
    why: 'An Azure OpenAI request URL is built from endpoint + deployment + api-version; any one missing yields a request that cannot be addressed, and the account is keyed.',
  },
  'llm:bedrock': {
    columns: ['region', 'apiKey'],
    why: 'Bedrock is addressed per region — the region is part of the endpoint, not a preference — and the account is keyed.',
  },

  // ── stt cloud vendors: an endpoint AND a key, neither defaulted ───────────
  //
  // TASK-983 R2. TASK-880 deleted the `stt.sarvam.baseUrl` / `stt.openai.baseUrl`
  // platform settings and moved the endpoint onto the connection row beside the
  // key. Both loaders read exactly that row and raise `CloudASRAuthError` when
  // either half is missing — inside a Dramatiq worker, as a 503, long after the
  // save that should have refused it. The endpoint is required rather than
  // DEFAULTED because the public `api.sarvam.ai` / `api.openai.com` carry no BAA:
  // a PHI platform must not pick a non-PHI-safe host on an operator's behalf, and
  // the seeded SYSTEM placeholders (disabled, with a baseUrl already set) stay
  // legal either way.
  'stt:sarvam': {
    columns: ['baseUrl', 'apiKey'],
    why: 'Sarvam ASR is BYOK-only with no env fallback, and `sarvam_loader.py` reads the endpoint off the SAME row as the key — so a keyed row without one loads nothing, and defaulting it would silently point PHI at the public api.sarvam.ai, which carries no BAA.',
  },
  'stt:openai': {
    columns: ['baseUrl', 'apiKey'],
    why: 'OpenAI ASR is BYOK-only with no env fallback, and `openai_loader.py` takes the endpoint from the row — which is also how the Azure-OpenAI-compatible deployments this loader exists to reach are addressed, so there is no one default that could stand in for it.',
  },

  // ── embeddings: the platform's own dense-embeddings server ────────────────
  //
  // TASK-952 D-1c. Deliberately NO `apiKey`: TEI authenticates nobody, and the
  // non-secret `not-needed` placeholder the row carries exists only so the
  // override fold has key material to deliver — requiring it here would make a
  // self-hosted row unsayable, exactly as for the four `llm` engines above.
  'embeddings:tei-embed': {
    columns: ['baseUrl'],
    extras: [{ key: 'model', label: 'the model id the server serves' }],
    why: 'TEI serves ONE model chosen at startup, so the endpoint alone does not say what will answer — and since the harness retired its hardcoded embeddings model this row is the only place the model id lives, so a blank one is a retrieval that degrades to empty context hours later instead of a 400 here.',
  },

  // ── model-registry: the weight-fetch plane ─────────────────────
  'model-registry:huggingface': {
    columns: ['apiKey'],
    extras: [{ key: 'model', label: 'the model id (org/repo)' }],
    platformDefaultWhenBlank: true,
    why: 'The hub performs no discovery for us: the repo is named explicitly, and a token is what distinguishes an entitled pull of a gated repo from an anonymous one — so a blank row is the anonymous built-in default, and a partly-filled one is neither.',
  },
  'model-registry:s3': {
    columns: ['baseUrl', 'apiKey'],
    extras: [{ key: 'accessKeyId', label: 'the access key id' }],
    platformDefaultWhenBlank: true,
    why: 'An S3/MinIO credential is a PAIR: the secret half is the encrypted key, and the non-secret principal id rides in extras (the ServiceAccount.clientId precedent). Neither half alone can sign a request — so a blank row means the platform storage credentials, and a partly-filled one is refused.',
  },
};

/** The declared requirement for `(service, provider)`, or `undefined` when there is none. */
export function requirementsFor(service: ProviderService, provider: string): ProviderRequirement | undefined {
  return PROVIDER_REQUIREMENTS[`${service}:${provider}`];
}

/** The merged state of the row being written, as the requirement check sees it. */
export interface ConnectionRequirementSubject {
  enabled: boolean;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  /** Whether the STORED row will hold key material — not whether this request carried one. */
  hasApiKey: boolean;
  extraJson?: unknown;
}

/**
 * Whether NOTHING this requirement asks for has been supplied (TASK-932 D-7).
 *
 * Read over the requirement's OWN field list rather than over the whole row: a
 * ceiling or a note is not credential material, and a row that carries only
 * those is still the built-in default.
 */
function isBlankForRequirement(requirement: ProviderRequirement, subject: ConnectionRequirementSubject): boolean {
  for (const column of requirement.columns) {
    if (columnPresent(subject, column)) return false;
  }
  const extras = sanitizeProviderExtras(subject.extraJson);
  for (const extra of requirement.extras ?? []) {
    const value = extras[extra.key];
    if (value !== undefined && String(value).trim() !== '') return false;
  }
  return true;
}

/** A column counts as supplied only when it holds something other than whitespace. */
function columnPresent(subject: ConnectionRequirementSubject, column: ProviderRequirementColumn): boolean {
  if (column === 'apiKey') return subject.hasApiKey;
  const value = subject[column];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Every reason this connection is not usable; `[]` means it is.
 *
 * Reports ALL misses rather than the first, so an operator fixes a form in one
 * round trip instead of one field per 400.
 *
 * Never echoes a stored VALUE — only the field name, what it is, and why the
 * provider needs it. Extras can carry operator-sensitive identifiers, and a 400
 * body is the wrong place to reflect them back.
 */
export function validateProviderRequirements(service: ProviderService, provider: string, subject: ConnectionRequirementSubject): string[] {
  // A row that will not participate in resolution cannot fail at request time.
  if (!subject.enabled) return [];

  const requirement = requirementsFor(service, provider);
  if (!requirement) return [];

  // TASK-932 D-7 — a blank row on a platform-managed plane IS the built-in
  // default. Checked before the per-field loop, because the answer is a property
  // of the row as a WHOLE: "nothing supplied" is configured, "something
  // supplied" re-arms every requirement.
  if (requirement.platformDefaultWhenBlank && isBlankForRequirement(requirement, subject)) return [];

  const context = `an enabled '${provider}' connection for the '${service}' capability`;
  const errors: string[] = [];

  for (const column of requirement.columns) {
    if (!columnPresent(subject, column)) {
      errors.push(`'${column}' is required for ${context} — ${COLUMN_LABELS[column]}.`);
    }
  }

  // Read the extras through the SAME sanitiser the wire fold uses. A key that
  // will be dropped in transit must not count as supplied here, or the check
  // would pass on a value the adapter never receives.
  const extras = sanitizeProviderExtras(subject.extraJson);
  for (const extra of requirement.extras ?? []) {
    const value = extras[extra.key];
    if (value === undefined) {
      errors.push(`'extraJson.${extra.key}' is required for ${context} — ${extra.label}.`);
      continue;
    }
    const reason = extra.validate?.(value);
    if (reason) {
      errors.push(`'extraJson.${extra.key}' ${reason} — ${extra.label}.`);
    }
  }

  return errors;
}

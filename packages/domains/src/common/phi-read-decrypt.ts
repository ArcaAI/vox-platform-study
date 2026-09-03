// Decrypt-on-read for the
// encrypt-only end state.
//
// Phase 6 DROPs the legacy plaintext PHI columns for 14 models. The plaintext
// fields survive as TRANSIENT in-memory entity properties; this module
// repopulates them from their Vault-Transit (hope-phi) ciphertext on every read
// so existing consumers (services, DTO mappers) keep working unchanged.
//
// Design (user-approved "Option A — auto-decrypt in the repository"):
//   - A single GLOBAL registry maps each dropped field's `encrypted<Field>`
//     ciphertext column to its transient plaintext property (+ JSON flag). Every
//     `encrypted*` name in the registry maps to exactly one (plaintext, json)
//     pair across the whole schema, so a flat lookup is unambiguous.
//   - The base Repository's `db` getter wraps the Prisma delegate (only when a
//     SecretsService has been wired, i.e. Vault mode) so every row-returning
//     read — and single-row write return — flows through `decryptPhiRows`. This
//     one wrap point covers BOTH the generic finders and every hand-written
//     custom finder (they all go through `this.db`), AND nested PHI rows pulled
//     in via `include` from ANY repository (e.g. Consultation.ContextItems),
//     which per-repo decryptors would miss.
//   - One Vault Transit BATCH decrypt per result set: all ciphertext across all
//     rows + nested relations is gathered and decrypted in a single round-trip
//     under the shared `hope-phi` key.
//
// Excluded models keep DISTINCT ciphertext names (GlobalSetting.encryptedValue,
// AuditLog.encryptedData/encryptedPreviousData, the WORM tables'
// encryptedBeforeJson/encryptedAfterJson/encryptedSensorScores/encryptedCitations)
// so they are never matched here and their plaintext payloads stay intact.

import { PHI_TRANSIT_KEY, type SecretsServiceLike } from './field-encryption';

/** Transient plaintext property name + whether the decrypted text is JSON. */
interface PhiPlaintextTarget {
  plaintext: string;
  json?: boolean;
}

/**
 * Global registry: `encrypted<Field>` ciphertext column → transient plaintext
 * target. The single source of truth for decrypt-on-read across all 14 Phase 6
 * models (30 dropped plaintext columns → 26 unique ciphertext columns; the
 * shared names — encryptedContent/encryptedText/encryptedReportData/
 * encryptedStyleText — map to the same plaintext+json everywhere, so dedup is
 * safe). Mirrors each model's `encrypt*IntoEntity` write mapping.
 */
export const PHI_CIPHERTEXT_FIELDS: Readonly<Record<string, PhiPlaintextTarget>> = Object.freeze({
  // ContextItem + ContextItemVersion
  encryptedContent: { plaintext: 'content' },
  encryptedContentDiff: { plaintext: 'contentDiff' },
  encryptedChangeSummary: { plaintext: 'changeSummary' },
  encryptedFieldChanges: { plaintext: 'fieldChanges', json: true },
  // Highlight
  encryptedExact: { plaintext: 'exact' },
  encryptedPrefix: { plaintext: 'prefix' },
  encryptedSuffix: { plaintext: 'suffix' },
  encryptedNote: { plaintext: 'note' },
  // NamedEntity (coded fields umlsCui/snomed/… are NOT encrypted — excluded)
  encryptedText: { plaintext: 'text' }, // NamedEntity + KnowledgeChunk
  encryptedNormalizedText: { plaintext: 'normalizedText' },
  encryptedMetadata: { plaintext: 'metadata', json: true },
  // SummaryMeta
  encryptedCitationsMap: { plaintext: 'citationsMap', json: true },
  encryptedGuardrailDecisions: { plaintext: 'guardrailDecisions', json: true },
  // TranscriptionJob
  encryptedResultText: { plaintext: 'resultText' },
  encryptedResultMetadata: { plaintext: 'resultMetadata', json: true },
  // GoldenCase
  encryptedTranscript: { plaintext: 'transcript' },
  encryptedReferenceNote: { plaintext: 'referenceNote' },
  // EvalRun / EvalScore
  encryptedNotes: { plaintext: 'notes' },
  encryptedRationale: { plaintext: 'rationale' },
  encryptedDetails: { plaintext: 'details', json: true },
  // DnaWritingStyleReport + DnaWritingStyleVersion
  encryptedReportData: { plaintext: 'reportData', json: true },
  encryptedStyleText: { plaintext: 'styleText' },
  // Notification (title is NOT encrypted — excluded)
  encryptedMessageText: { plaintext: 'messageText' },
  encryptedMessageRichText: { plaintext: 'messageRichText' },
  encryptedMessageContent: { plaintext: 'messageContent', json: true },
  // PromptTemplate
  encryptedLastTestOutput: { plaintext: 'lastTestOutput' },
  // WorkflowTestFixture — the saved Workbench test payload
  encryptedInput: { plaintext: 'input', json: true },
});

/**
 * MODEL-SCOPED ciphertext columns — the authority for what may be decrypted.
 *
 * Keyed by Prisma DELEGATE name (camelCase, i.e. `Repository._modelName`), each
 * entry lists the ciphertext columns that model actually DECLARES in the Prisma
 * schema. Matching by bare key name anywhere in the object graph (the previous
 * behaviour) was both a crash and a disclosure hazard: `AuditLog.data` /
 * `previousData` / `metaData` are opaque JSON SNAPSHOTS of mutated entities, and
 * a snapshot of a PHI entity serialises its ciphertext Buffer as
 * `{"type":"Buffer","data":[…]}` under the very same `encrypted*` key. Walking
 * into those payloads either threw (`Buffer.from(object)`) or — when the value
 * happened to be well-formed bytes — silently decrypted PHI into an audit
 * response. Neither can happen now: `auditLog` declares no ciphertext column and
 * no relation edge, so nothing under it is ever read.
 *
 * Derived from `packages/database/src/prisma/db_main/*.prisma`; the parity test
 * `phi-read-decrypt.schema-parity.test.ts` re-derives it and fails on drift.
 */
export const PHI_MODEL_CIPHERTEXT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  contextItem: ['encryptedContent'],
  contextItemVersion: ['encryptedChangeSummary', 'encryptedContent', 'encryptedContentDiff', 'encryptedFieldChanges'],
  dnaWritingStyleReport: ['encryptedReportData', 'encryptedStyleText'],
  dnaWritingStyleVersion: ['encryptedReportData', 'encryptedStyleText'],
  // a live-generated document's section prose. Unlike its sibling
  // `TranscriptSegment` (structural metadata only) a section CARRIES PHI: the
  // text is generated and exists nowhere else to slice from.
  documentSection: ['encryptedContent'],
  evalRun: ['encryptedNotes'],
  evalScore: ['encryptedDetails', 'encryptedRationale'],
  goldenCase: ['encryptedReferenceNote', 'encryptedTranscript'],
  highlight: ['encryptedExact', 'encryptedNote', 'encryptedPrefix', 'encryptedSuffix'],
  knowledgeChunk: ['encryptedText'],
  namedEntity: ['encryptedMetadata', 'encryptedNormalizedText', 'encryptedText'],
  notification: ['encryptedMessageContent', 'encryptedMessageRichText', 'encryptedMessageText'],
  promptTemplate: ['encryptedLastTestOutput'],
  summaryMeta: ['encryptedCitationsMap', 'encryptedGuardrailDecisions'],
  transcriptionJob: ['encryptedResultMetadata', 'encryptedResultText'],
  workflowTestFixture: ['encryptedInput'],
});

/**
 * Declared RELATION edges (delegate name → relation field → child delegate name)
 * on every path that can reach a model in `PHI_MODEL_CIPHERTEXT`. Recursion
 * follows ONLY these edges, so it descends into genuine nested relation rows
 * pulled in via `include` and never into a `Json`/`JsonB` scalar column — those
 * are not relations and therefore have no edge. A model absent from this map is
 * a leaf for walking purposes.
 *
 * Same provenance and parity guard as `PHI_MODEL_CIPHERTEXT` above.
 */
export const PHI_MODEL_RELATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  apiKey: { user: 'user' },
  asrPipeline: { TranscriptionJobs: 'transcriptionJob', Versions: 'asrPipelineVersion' },
  asrPipelineVersion: { AsrPipeline: 'asrPipeline' },
  audioRecording: { ContextItem: 'contextItem' },
  consultation: {
    ChildConsultations: 'consultation',
    ContextItems: 'contextItem',
    Department: 'department',
    Doctor: 'user',
    DocumentSections: 'documentSection',
    Highlights: 'highlight',
    ParentConsultation: 'consultation',
  },
  consultationContextSchema: { Department: 'department', Versions: 'consultationContextSchemaVersion' },
  consultationContextSchemaVersion: { Schema: 'consultationContextSchema' },
  contextItem: {
    AudioRecordings: 'audioRecording',
    Consultation: 'consultation',
    NamedEntities: 'namedEntity',
    SummaryMeta: 'summaryMeta',
    TranscriptNamedEntities: 'namedEntity',
    TranscriptSegments: 'transcriptSegment',
    Versions: 'contextItemVersion',
  },
  contextItemVersion: { ContextItem: 'contextItem' },
  department: {
    ChildDepartments: 'department',
    ConsultationContextSchemas: 'consultationContextSchema',
    Consultations: 'consultation',
    ParentDepartment: 'department',
    PromptTemplates: 'promptTemplate',
    UserDepartments: 'userDepartment',
  },
  documentSection: { Consultation: 'consultation' },
  dnaWritingStyleReport: { Doctor: 'user', Versions: 'dnaWritingStyleVersion' },
  dnaWritingStyleVersion: { DnaWritingStyleReport: 'dnaWritingStyleReport' },
  evalRun: { EvalScores: 'evalScore', GoldenSet: 'goldenSet' },
  evalScore: { EvalRun: 'evalRun', GoldenCase: 'goldenCase' },
  goldenCase: { EvalScores: 'evalScore', GoldenSet: 'goldenSet' },
  goldenSet: { EvalRuns: 'evalRun', GoldenCases: 'goldenCase' },
  highlight: { Consultation: 'consultation' },
  knowledgeChunk: { KnowledgeDocument: 'knowledgeDocument' },
  knowledgeDocument: { KnowledgeChunks: 'knowledgeChunk' },
  media: { Bucket: 'tenantBucket', UserMedias: 'userMedia' },
  namedEntity: { ContextItem: 'contextItem', TranscriptContextItem: 'contextItem' },
  notification: { ResourceSubscription: 'resourceSubscription', TargetUser: 'user' },
  passwordResetToken: { User: 'user' },
  policy: { RolePolicies: 'rolePolicy' },
  promptTemplate: { Department: 'department', Owner: 'user', Versions: 'promptVersion' },
  promptVersion: { PromptTemplate: 'promptTemplate' },
  resourceSubscription: { Notifications: 'notification', Subscribers: 'user' },
  role: { ChildRoles: 'role', ParentRole: 'role', RolePolicies: 'rolePolicy', UserRoleAssignments: 'userRoleAssignment' },
  rolePolicy: { Policy: 'policy', Role: 'role' },
  storageAccessKey: { Buckets: 'tenantBucket' },
  summaryMeta: { ContextItem: 'contextItem' },
  tenantBucket: { Medias: 'media', StorageAccessKeys: 'storageAccessKey', StorageConfigs: 'tenantStorageConfig' },
  tenantStorageConfig: { Bucket: 'tenantBucket' },
  transcriptSegment: { ContextItem: 'contextItem' },
  transcriptionJob: { Pipeline: 'asrPipeline' },
  user: {
    ApiKeys: 'apiKey',
    DoctorConsultations: 'consultation',
    DoctorDnaReports: 'dnaWritingStyleReport',
    OwnedPromptTemplates: 'promptTemplate',
    PasswordResetTokens: 'passwordResetToken',
    ResourceSubscriptions: 'resourceSubscription',
    UserDepartments: 'userDepartment',
    UserMedias: 'userMedia',
    UserNotifications: 'notification',
    UserProfile: 'userProfile',
    UserRoleAssignments: 'userRoleAssignment',
    UserSettings: 'userSettings',
    VoiceProfiles: 'userVoiceProfile',
  },
  userDepartment: { Department: 'department', User: 'user' },
  userMedia: { Media: 'media', User: 'user' },
  userProfile: { User: 'user' },
  userRoleAssignment: { Role: 'role', User: 'user' },
  userSettings: { User: 'user' },
  userVoiceProfile: { User: 'user' },
});

// Process-wide SecretsService handle for repository decrypt-on-read. Set ONCE
// per process by the application-layer PHI initializer when
// SECRETS_PROVIDER=vault; left undefined in env-mode dev/test and in unit tests
// so reads stay a no-op (no Vault dependency, no throw, no delegate wrapping).
let _phiReadSecrets: SecretsServiceLike | undefined;

/** Wire (or clear) the process-wide SecretsService used by repository decrypt-on-read. */
export function setPhiReadSecrets(secrets: SecretsServiceLike | undefined): void {
  _phiReadSecrets = secrets;
}

/** Current process-wide SecretsService for decrypt-on-read (undefined ⇒ disabled / no-op). */
export function getPhiReadSecrets(): SecretsServiceLike | undefined {
  return _phiReadSecrets;
}

// Prisma delegate methods whose resolved rows must be decrypted. Reads return
// row(s); single-row writes return the written row (consumers read the
// transient plaintext off the returned entity, e.g. addContext → response DTO).
// createMany/updateMany/deleteMany/count/aggregate/groupBy return non-row shapes
// and intentionally pass through untouched.
const DECRYPT_METHODS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'update', 'upsert']);

/**
 * Wrap a Prisma model delegate so row-returning reads and single-row write
 * returns pass their result through `decryptPhiRows` before resolving. Every
 * other delegate method passes through untouched (bound to preserve `this`).
 * Only invoked from the base `db` getter when a SecretsService is wired.
 */
export function wrapDelegateWithPhiDecrypt<T extends object>(delegate: T, modelName: string): T {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function' || typeof prop !== 'string') {
        return orig;
      }
      if (DECRYPT_METHODS.has(prop)) {
        return async (...args: unknown[]): Promise<unknown> => {
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (result) await decryptPhiRows(result, modelName);
          return result;
        };
      }
      return (orig as (...a: unknown[]) => unknown).bind(target);
    },
  }) as T;
}

interface DecryptJob {
  ct: string;
  apply: (plaintext: string) => void;
}

const SKIP_RECURSE = (v: unknown): boolean => v instanceof Uint8Array || v instanceof Date || Buffer.isBuffer(v);

/**
 * Recursively walk a Prisma row graph, collecting ciphertext→setter jobs for
 * every registered `encrypted<Field>` column found on any node, and descending
 * into nested relation objects/arrays (so includes from any parent are covered).
 */
function collectNode(node: unknown, modelName: string, jobs: DecryptJob[], seen: Set<object>): void {
  if (!node || typeof node !== 'object' || SKIP_RECURSE(node)) return;

  if (Array.isArray(node)) {
    for (const item of node) collectNode(item, modelName, jobs, seen);
    return;
  }

  if (seen.has(node)) return;
  seen.add(node);

  const row = node as Record<string, unknown>;

  // 1) Decrypt ONLY the ciphertext columns this model declares.
  for (const key of PHI_MODEL_CIPHERTEXT[modelName] ?? []) {
    if (!(key in row)) continue;
    const target = PHI_CIPHERTEXT_FIELDS[key];
    if (!target) continue;
    const raw = row[key];
    if (!(raw instanceof Uint8Array)) {
      // A declared ciphertext column that is not bytes is either absent (null)
      // or not a live column value; treat as "no data" rather than guessing.
      if (raw === null || raw === undefined) row[target.plaintext] = null;
      continue;
    }
    if (raw.length === 0) {
      // Ciphertext column present but empty ⇒ no data; null the transient field.
      row[target.plaintext] = null;
      continue;
    }
    const ct = Buffer.from(raw).toString('utf8');
    const t = target;
    jobs.push({
      ct,
      apply: (plaintext: string) => {
        row[t.plaintext] = t.json ? JSON.parse(plaintext) : plaintext;
      },
    });
  }

  // 2) Recurse ONLY through DECLARED relations. Json/JsonB payload columns
  //    (AuditLog.data/previousData/metaData and friends) are scalars, have no
  //    relation edge, and are therefore never entered.
  const relations = PHI_MODEL_RELATIONS[modelName];
  if (!relations) return;
  for (const [field, childModel] of Object.entries(relations)) {
    const value = row[field];
    if (value && typeof value === 'object') collectNode(value, childModel, jobs, seen);
  }
}

/**
 * Decrypt-on-read entry point used by the wrapped Prisma delegate. Gathers every
 * registered ciphertext across the whole result set (+ nested relations) and
 * issues ONE Vault Transit BATCH decrypt under the shared `hope-phi` key, then
 * writes each plaintext back onto its transient property. No-op when no
 * SecretsService is wired (env-mode dev/test) or when the result has no PHI
 * ciphertext.
 */
export async function decryptPhiRows(rows: unknown, modelName: string): Promise<void> {
  const secrets = getPhiReadSecrets();
  if (!secrets) return;

  const jobs: DecryptJob[] = [];
  collectNode(rows, modelName, jobs, new Set<object>());
  if (jobs.length === 0) return;

  const keyName = secrets.getPhiTransitKeyName?.() ?? PHI_TRANSIT_KEY;
  const ciphertexts = jobs.map((j) => j.ct);

  let plaintexts: string[];
  if (typeof secrets.decryptBatch === 'function') {
    // One batch round-trip for the whole result set (the Phase 6 guardrail).
    const buffers = await secrets.decryptBatch(ciphertexts, keyName);
    plaintexts = buffers.map((b) => Buffer.from(b).toString('utf8'));
  } else {
    // Fallback for SecretsServices without batch support (e.g. unit mocks):
    // N parallel decrypts. Real runtime uses the Vault batch path above.
    const buffers = await Promise.all(ciphertexts.map((ct) => secrets.decrypt(ct, keyName)));
    plaintexts = buffers.map((b) => Buffer.from(b).toString('utf8'));
  }

  for (let i = 0; i < jobs.length; i++) jobs[i].apply(plaintexts[i]);
}

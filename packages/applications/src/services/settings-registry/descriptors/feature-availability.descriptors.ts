// Feature availability — the ONE place a platform admin decides which features
// exist, per tenant.
//
// ── WHY THIS CATEGORY EXISTS (TASK-932 R-8, D-3) ─────────────────────────────
// "Feature Flags" used to name three unrelated things at once: env-tier gates
// nobody could write (`feature-flags.descriptors.ts`), consultation-pipeline
// kill-switches and tuning knobs (`consultation-gates.descriptors.ts`), and a
// legacy `GlobalSetting` namespace of advisory rows with no reader at all.
// Three surfaces, one word, and no admin could tell which of them a toggle
// belonged to. The category is dissolved; what remains is this one, whose
// membership test is sharp:
//
//   a `Feature Availability` key answers "does this capability exist for this
//   tenant?" — nothing else. It is `global-kv` (so it changes without a
//   redeploy), boolean, and resolved by the standard tenant → SYSTEM cascade.
//
// A capacity knob, a threshold, a cron, an emergency stop, a credential — none
// of those belong here, however boolean they look. `harness.loop.emergencyStop`
// is the worked counter-example: its polarity is inverted (true = STOP), so a
// checkbox column headed "available" would read backwards for it. It lives in
// `Platform Operations`.
//
// ── globalOnly, and why `maxScope: 'tenant'` is not a contradiction ──────────
// Every key here is `globalOnly: true`: the PLATFORM decides what a tenant may
// see and use, and a tenant that could grant itself a feature is not being
// gated. `maxScope: 'tenant'` is the orthogonal question — WHERE a row may
// live — and it is what lets a platform admin roll a feature out one tenant at
// a time. Same pairing, same reasoning, as
// `consultation.realtime.graphExecutor.enabled` (owner decision 2026-09-05).
//
// A key whose CONSUMER has no tenant in hand stays `maxScope: 'system'` rather
// than advertising a per-tenant row that could never be enforced —
// `registration.selfSignupEnabled` is the one such key here (its routes are
// `@Public()`, so there is no tenant to resolve against). The matrix screen
// renders those rows with the tenant columns disabled instead of pretending.
//
// ── KILL-SWITCH POLARITY ────────────────────────────────────────────────────
// `SettingsRegistry.killSwitches()` THROWS at assembly for any kill-switch that
// defaults ON, so `killSwitch: true` appears here only on the default-OFF keys.
// `workflowExposure.enabled` ships ON (TASK-890 J7-5) and therefore carries no
// marker — the same rule, not an exception to it.
//
// ── THE FOUR CONSOLE GATES ARE VISIBILITY, NOT AUTHORISATION (D-2) ──────────
// `console.*` keys decide whether a screen is offered in the admin console (nav
// entry + a 404 on the route). They are NOT an authorisation boundary: the
// gateway routes behind those screens stay ability-gated exactly as before, and
// turning a console gate off never widens or narrows what an API or SDK caller
// may do. Say so in the label, so nobody mistakes one for a permission.

import { SettingDescriptor, SettingScope } from '../registry.types';

/** The server-side taxonomy bucket the matrix screen and its endpoints select on. */
export const FEATURE_AVAILABILITY_CATEGORY = 'Feature Availability';

// Key constants for the consumers that RESOLVE these gates. Exported so a
// reader names the key once and the registry owns the spelling -- the
// `consultation-gates.constants.ts` shape, for the same reason: a dotted string
// typed twice is a gate that silently stops gating when one copy is edited.
export const REGISTRATION_SELF_SIGNUP_ENABLED_KEY = 'registration.selfSignupEnabled';
export const WORKFLOW_EXPOSURE_ENABLED_KEY = 'workflowExposure.enabled';
export const LIVE_DOC_GROUNDEDNESS_ENABLED_KEY = 'liveDoc.groundedness.enabled';

/**
 * The four CONSOLE visibility gates, named so Lane N's `useFeatureGates()` and
 * the nav config select on constants rather than on literals.
 */
export const CONSOLE_FEATURE_KEYS = {
  toolsMcp: 'console.tools.mcp.enabled',
  mlflow: 'console.mlflow.enabled',
  agenticPolicy: 'console.agenticPolicy.enabled',
  workflowHarness: 'console.workflowHarness.enabled',
} as const;

interface FeatureSpec {
  key: string;
  label: string;
  description: string;
  /** The code default — the last fallback in the cascade. */
  default: boolean;
  /**
   * Deepest scope a row may live at. `tenant` (the norm here) is what makes the
   * per-tenant matrix column writable; `system` marks a key whose consumer has
   * no tenant in hand, so a tenant row could never be enforced.
   */
  maxScope?: SettingScope;
}

const FEATURES: FeatureSpec[] = [
  // ── Console visibility gates (TASK-932 R-4, R-10, R-14) ───────────────────
  {
    key: CONSOLE_FEATURE_KEYS.toolsMcp,
    label: 'Tools & MCP (console)',
    description:
      'Offers the Tools & MCP screen in the admin console (nav entry + route). VISIBILITY ONLY — `admin/mcp-servers` stays ability-gated for API and SDK callers, and the harness runtime MCP path is governed by `HarnessPolicy.mcpToolsEnabled` (OD-11), not by this key. Defaults OFF: a platform admin turns it on per tenant, or platform-wide.',
    default: false,
  },
  {
    key: CONSOLE_FEATURE_KEYS.mlflow,
    label: 'MLflow (console)',
    description:
      'Offers the MLflow screen under AI services (nav entry + route). VISIBILITY ONLY — the MLflow deployment and its own auth are unaffected. Defaults OFF.',
    default: false,
  },
  {
    key: CONSOLE_FEATURE_KEYS.agenticPolicy,
    label: 'Agentic policy (console)',
    description:
      'Offers the Agentic policy screen (nav entry + route), the authoritative editor for `harness/policy/global` + `harness/live/config`. VISIBILITY ONLY — the harness policy routes stay ability-gated. Defaults OFF.',
    default: false,
  },
  {
    key: CONSOLE_FEATURE_KEYS.workflowHarness,
    label: 'Workflow & Harness (console)',
    description:
      'Offers the whole Workflow & Harness domain in the admin console — harness policy, harness observability, harness workflows and workflow runs (nav domain + routes). VISIBILITY ONLY — every route behind it stays ability-gated, and workflow EXECUTION is unaffected. Defaults OFF.',
    default: false,
  },

  // ── Migrated off `tier: 'env'` (TASK-932 D-4) ─────────────────────────────
  {
    key: REGISTRATION_SELF_SIGNUP_ENABLED_KEY,
    label: 'Self-service registration',
    description:
      "Gates the public self-signup routes: `RegisterController` answers 404 (not 403) when off, so the endpoint's existence is not disclosed. MIGRATED from `REGISTRATION_SELF_SIGNUP_ENABLED` to `global-kv`, so it flips without a redeploy. `maxScope: 'system'` and not `tenant`: both routes are `@Public()` and carry no tenant context, so a per-tenant row could never be enforced — declaring one would advertise a control that does nothing.",
    default: false,
    maxScope: 'system',
  },
  {
    key: WORKFLOW_EXPOSURE_ENABLED_KEY,
    label: 'Workflow exposure plane (public invoke)',
    description:
      'Gates the whole `/api/v1/workflows/:slug/…` public-invoke surface — a 404 (existence not disclosed) while off, the same posture as `registration.selfSignupEnabled`. MIGRATED from `WORKFLOW_EXPOSURE_ENABLED` to `global-kv`, and it gains a per-tenant row: `WorkflowExposureService` already resolves a tenant on every call, so a platform admin can withdraw the plane from ONE tenant without taking it from everyone. SHIPS ON: the original precondition ("API-key scope enforcement must be verified end-to-end before this ships enabled") was discharged by TASK-757 (`@ForbidApiKey()` enforced ahead of the scope check, plus the boot audit that refuses startup when an admin route declares an API-key scope) and TASK-776 (the route-authz matrix over every route, plus the credential-class depth suites). Left off, a fresh install 404s the entire workflow plane, which is what the pre-production posture — ship complete and ENABLED — exists to avoid. A platform admin turns it off deliberately.',
    default: true,
  },
  {
    key: LIVE_DOC_GROUNDEDNESS_ENABLED_KEY,
    label: 'Live-doc groundedness gate',
    description:
      'Runs the output-side groundedness check on the live-documentation path: the generated note is verified against the source transcript BETWEEN building it and publishing it, so ungrounded segments carry their mark before the clinician reads them. MIGRATED from `LIVE_DOC_GROUNDEDNESS_ENABLED`, which was read ONCE in the `LiveDocumentationService` constructor and therefore needed a restart; it is now resolved per flush against the session tenant, so a rollout is per tenant and immediate. Enabling it requires the guardrail service and its self-hosted NLI model staged — degrade is fail-CLOSED (an unavailable gate marks segments `unverified`, never `grounded`).',
    default: false,
  },
];

export const FEATURE_AVAILABILITY_SETTINGS: SettingDescriptor[] = FEATURES.map<SettingDescriptor>((feature) => ({
  key: feature.key,
  // `global-kv`, present tense: the READER moved in the same change for all
  // three migrated keys, so there is no `targetTier` left to record. The
  // honesty rule of `platform-knobs.descriptors.ts` applies — a catalog that
  // claims a tier its reader does not use is worse than no catalog.
  tier: 'global-kv',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: feature.maxScope ?? 'tenant',
  editableBy: 'GlobalSetting',
  // The PLATFORM decides availability; `maxScope: 'tenant'` decides WHERE the
  // row lives. See the header — the two fields answer different questions.
  globalOnly: true,
  // A feature gate whose value cannot be resolved must behave as its default,
  // never raise: an unreachable control plane may not take a console screen or
  // a public plane down with it. Every default below is the safe end.
  failMode: 'open-to-default',
  ...(feature.default === false ? { killSwitch: true } : {}),
  category: FEATURE_AVAILABILITY_CATEGORY,
  label: feature.label,
  description: feature.description,
  default: feature.default,
}));

/** Every feature-availability key, in declaration order. The matrix rows. */
export const FEATURE_AVAILABILITY_KEYS: readonly string[] = FEATURE_AVAILABILITY_SETTINGS.map((d) => d.key);

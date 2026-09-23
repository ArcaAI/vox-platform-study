// TASK-1001 (owner decision 2026-09-23) — the PLATFORM DEFAULT for the language a consultation's
// notes are WRITTEN in.
//
// ## Why this key exists
//
// *"ALaaS still sends the language: `ml-en` indicates code-mixed/code-switch enabled for
// realtime/job transcription, Malayalam as the main language. The summarization (both pre-summary
// and summary) is still in English, by admin configuration OR by default."*
//
// `OpenConsultationRequest.language` is the SOURCE language — what is spoken — so it can no longer
// be where the note's language comes from. The note's OUTPUT language resolves in two tiers:
//   1. the tenant's output-language POLICY FRAGMENT (`OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY` in
//      `@arcaai/types`), when it is selected for the generation — CONTENT the tenant authors;
//   2. otherwise THIS key — CONFIGURATION the platform owns.
// `resolveOutputLanguage` in `consultation/consultation/summary-language.ts` is that rule.
//
// "By default" is a default, so it is a descriptor rather than a literal in three call sites
// (`00-project-context.md` §Configuration Principles: a label set or a language is config). And it
// is the RUNTIME-editable lever: the policy fragment's text is frozen into each agent's
// `compiledConfig` at publish, so editing the shared policy template changes nothing until every
// agent is republished, while a write to this key governs the next generation.
//
// ## Why platform scope (`maxScope: 'system'`, `globalOnly`)
//
// A tenant's opinion on its notes' language already has a home — the policy fragment, which can
// be conditional on the consultation's context and which an admin sees in the draft test panel.
// A tenant-scope row here would be a second, unconditional place to say the same thing, and the two
// could disagree with no rule to settle them. This key answers only "what does the PLATFORM write
// when the tenant has said nothing".
//
// ## Why `open-to-default`
//
// Absent must never mean "no instruction": that is exactly the posture that let the clinical
// corpus's own "write content in the conversation language" clause win and produced a
// code-switched hematology note. An absent row therefore resolves to the code default, English.
//
// ## Why `consumedBy: ['harness']` (TASK-1001 lane L-B)
//
// The DURABLE lane runs in `apps/harness`, and it writes notes too: `platform-default-summarization`
// runs the SYSTEM `general-medicine-summarization` agent there, whose body says "write … in the
// conversation language ({{language}})". Its `core.agent` TEXT_GENERATION activity now states this
// default exactly as the live lane's `operatingFrame` does (when no tenant policy fragment is
// selected), and it reads the value on `GET /internal/effective-config?service=harness` — the pull
// route every other harness knob rides, with its TTL, negative cache and push invalidation. That
// route is PLATFORM-scope, which is exactly this key's `maxScope`: one value, no tenant opinion, so
// the one-snapshot-per-process channel is the right one (`registry.types.ts` `consumedBy`). The
// gateway's own readers (the live flush, the durable handoff) keep resolving it directly.

import { OUTPUT_LANGUAGE_DEFAULT, SUMMARY_LANGUAGE_PATTERN } from '../../consultation/consultation/summary-language';
import { SettingDescriptor } from '../registry.types';

/** The platform-default OUTPUT language of every native consultation note (live, pre-summary, final). */
export const CONSULTATION_OUTPUT_LANGUAGE_KEY = 'consultation.summary.outputLanguage';

/** The descriptor's code default — declared once, beside the resolver that falls back to it. */
export const CONSULTATION_OUTPUT_LANGUAGE_DEFAULT = OUTPUT_LANGUAGE_DEFAULT;

export const CONSULTATION_OUTPUT_LANGUAGE_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_OUTPUT_LANGUAGE_KEY,
    tier: 'global-kv',
    // The durable lane's reader — see the header. The ONLY wiring step: this is what puts the key
    // on `GET /internal/effective-config?service=harness`.
    consumedBy: ['harness'],
    dataType: 'string',
    sensitivity: 'internal',
    // PLATFORM-owned — see the header: the tenant's lever is its policy fragment.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // An absent row degrades to English, never to "no language stated". (`failMode` governs an
    // ABSENT VALUE only — a settings-backend error still propagates to the caller, which on the
    // live flush and finalize paths logs it and writes in the code default rather than failing a
    // clinician's note.)
    failMode: 'open-to-default',
    // Beside the other knobs of the running documentation loop, which the /agentic-policy
    // "Agentic Context" tab renders and edits with no UI work.
    category: 'Agentic Context',
    label: 'Default note output language',
    description:
      "BCP-47 tag of the language every consultation note — live summary, pre-summary and final summary — is written in when the tenant's output-language policy does not state one. It is never taken from the consultation's declared language, which describes what is SPOKEN (for example the code-switch mode `ml-en`). The runtime states it explicitly and overrides the clinical templates' own \"write content in the conversation language\" clause; section keys and headings always stay in English. A code-switch mode such as `ml-en` is refused: a note is written in one language. Read at the start of each recording session and each summary generation — no redeploy, and no agent republish.",
    default: CONSULTATION_OUTPUT_LANGUAGE_DEFAULT,
    // Strict (no trim): the stored value is the canonical tag, so what an admin reads back is what
    // the runtime states.
    validate: (value: unknown) => {
      if (typeof value !== 'string' || !SUMMARY_LANGUAGE_PATTERN.test(value)) {
        return 'Default note output language must be ONE BCP-47 language tag such as `en`, `ml` or `en-IN`. A code-switch mode such as `ml-en` describes what is spoken, not what a note is written in, and is refused.';
      }
    },
  },
];

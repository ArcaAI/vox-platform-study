import { ResourceStatusType } from '../../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID } from '../00-constants';
import { AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType, type AiModelSeed } from './shared';

/**
 * NLP task-model catalog — the two `built-in`
 * (transformers-library) models the NLP service serves. Registry-backed
 * defaults for the `nlp.ner` / `nlp.classification` AiTaskDefault keys.
 */
export const NLP_AI_MODELS: AiModelSeed[] = [
  {
    id: '80000000-0000-0000-0007-000000000010',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Medical NER',
    slug: 'medical-ner',
    description: 'blaze999/Medical-NER — medical named-entity recognition (token classification). Platform default for nlp.ner (AiTaskDefault).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'blaze999/Medical-NER',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: null,
    memorySizeMb: 1024,
    computeType: 'float32',
    tags: ['medical', 'ner', 'default'],
  },
  {
    id: '80000000-0000-0000-0007-000000000011',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Symptom-Disease BERT v3 C41',
    slug: 'symps-disease-bert-v3-c41',
    description:
      'shanover/symps_disease_bert_v3_c41 — symptom→disease text classification (diagnosis suggestion). Platform default for nlp.classification (AiTaskDefault).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'shanover/symps_disease_bert_v3_c41',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: 'bert',
    memorySizeMb: 512,
    computeType: 'float32',
    tags: ['medical', 'classification', 'default'],
  },
  // ── Guardrail-plane models (TASK-735 Phases 3 & 6; roster completed by TASK-776) ──
  //
  // Owner directive 2026-08-19. THREE models, all RUNNING IN `apps/nlp`
  // (guardrail holds zero resident weights), selected from here via
  // `guardrail.pii`, `guardrail.pii.spans` and `guardrail.safety` in
  // `16-ai-task-default.ts`. They are split BY TASK SHAPE, not by vendor:
  //
  //   1. token classification + ENTITY EXTRACTION (PII detect/redact/mask):
  //      `gliner2-privacy-filter-pii-multi`  — 205M, PII spans ONLY. The
  //      high-volume redaction default: smallest, therefore fastest, and every
  //      consultation turn is scanned.
  //      `gliner2-guardrails-pii-multi`      — 300M, PII spans AND safety
  //      classification in ONE checkpoint. Selected where safety needs SPANS
  //      (not just a label), or where one model must cover both jobs on a
  //      memory-constrained node.
  //   2. safety CLASSIFICATION ONLY (no entity extraction):
  //      `gliguard-llm-guardrails-300m`      — 300M, six moderation tasks.
  //
  // Verified empirically against the real weights on 2026-08-19: all three load
  // through the same `gliner2` runtime and share one call shape, so the
  // difference between them is a CAPABILITY ENVELOPE, not a code path.
  // `metaData.capabilities` declares it, and `apps/nlp` never branches on a
  // model id.
  //
  // `sourceUri` is a MODEL REFERENCE and is deliberately NOT constrained to a
  // hub-id pattern: the gliner2 loader accepts a hub id or a local filesystem
  // path, and both a super admin (these SYSTEM rows) and a tenant admin (their
  // own tenant rows) may configure either. Seed data uses hub ids; a local path
  // is resolved fail-closed by `nlp/core/guard_model_reference.py` — a missing
  // or unreadable path is an error, never a silent hub download.
  //
  // `metaData.labelTaxonomy` is load-bearing, not documentation: guardrail reads
  // it through the SAME tenant → SYSTEM cascade that resolves the selection
  // (`core/tenant_config.py`, `AiModel._metadata`), which is exactly what makes
  // the label sets CONFIGURATION rather than Python literals. `seedAiModels`
  // re-syncs `metaData` on re-seed, so a platform admin edit here propagates.
  // Guardrail carries NO built-in taxonomy: an absent one fails closed (503).
  //
  // The label sets below are transcribed VERBATIM from each model card — a
  // fabricated label would simply never fire.
  {
    id: '80000000-0000-0000-0007-000000000017',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GLiNER2 Privacy Filter PII (multi)',
    slug: 'gliner2-privacy-filter-pii-multi',
    description:
      'fastino/gliner2-privacy-filter-PII-multi — GLiNER2 PII span detector. Platform default for guardrail.pii (PHI redaction + PII detection). Owner directive: ENGLISH ONLY on this platform, though the model itself is multilingual.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'fastino/gliner2-privacy-filter-PII-multi',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: 'gliner2',
    memorySizeMb: 1024,
    computeType: 'float32',
    tags: ['guardrail', 'pii', 'gliner2', 'redaction'],
    metaData: {
      // English only (owner directive) — the model card also lists fr/es/de/it/pt/nl.
      languages: ['en'],
      // What `apps/nlp` may ask this checkpoint to do. This row is extraction
      // ONLY: it has no classification head, so a `guardrail.safety` selection
      // pointing here would fail at inference rather than mis-answer.
      capabilities: ['extract_entities'],
      labelTaxonomy: {
        threshold: 0.5,
        // All 42 entity types from the model card, in its own grouping order.
        labels: [
          // person / names
          'person', 'full_name', 'first_name', 'middle_name', 'last_name', 'date_of_birth',
          // contact / address
          'email', 'phone_number', 'address', 'street_address', 'city', 'state_or_region',
          'postal_code', 'country',
          // government / tax ids
          'government_id', 'national_id_number', 'passport_number', 'drivers_license_number',
          'license_number', 'tax_id', 'tax_number',
          // banking / payment
          'bank_account', 'account_number', 'routing_number', 'iban', 'payment_card',
          'card_number', 'card_expiry', 'card_cvv',
          // digital identity
          'username', 'ip_address', 'account_id', 'sensitive_account_id',
          // secrets / credentials
          'password', 'secret', 'api_key', 'access_token', 'recovery_code',
          // sensitive dates
          'sensitive_date', 'document_date', 'expiration_date', 'transaction_date',
        ],
      },
    },
  },
  // The JOINT checkpoint (TASK-776). Same 42 PII types as the privacy filter —
  // its card lists an identical set — PLUS the six GLiGuard moderation tasks.
  // Seeded so a platform admin can select it wherever safety needs SPANS, or
  // where one resident model must cover both jobs.
  {
    id: '80000000-0000-0000-0007-000000000026',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GLiNER2 Guardrails + PII (multi)',
    slug: 'gliner2-guardrails-pii-multi',
    description:
      'fastino/GLiNER2-Guardrails-PII-Multi — the JOINT GLiNER2 checkpoint: PII spans AND six-task LLM safety moderation in one 300M model. Platform default for guardrail.pii.spans (safety where spans are needed). Owner directive: ENGLISH ONLY on this platform, though the model itself is multilingual.',
    category: ModelCategory.NLP,
    // Its primary shape is span extraction; the classification head rides along.
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'fastino/GLiNER2-Guardrails-PII-Multi',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: 'gliner2',
    memorySizeMb: 1400,
    computeType: 'float32',
    tags: ['guardrail', 'pii', 'safety', 'moderation', 'gliner2', 'redaction'],
    metaData: {
      // English only (owner directive) — the card also lists fr/es/de/it/pt/nl.
      languages: ['en'],
      // The ONLY row in this file that carries BOTH verbs. That is the entire
      // reason it exists alongside the privacy filter, and it is declared here
      // as configuration rather than inferred from the id in Python.
      capabilities: ['extract_entities', 'classify_text'],
      labelTaxonomy: {
        threshold: 0.5,
        // 42 PII entity types, identical to the privacy-filter row's set.
        labels: [
          // person / names
          'person', 'full_name', 'first_name', 'middle_name', 'last_name', 'date_of_birth',
          // contact / address
          'email', 'phone_number', 'address', 'street_address', 'city', 'state_or_region',
          'postal_code', 'country',
          // government / tax ids
          'government_id', 'national_id_number', 'passport_number', 'drivers_license_number',
          'license_number', 'tax_id', 'tax_number',
          // banking / payment
          'bank_account', 'account_number', 'routing_number', 'iban', 'payment_card',
          'card_number', 'card_expiry', 'card_cvv',
          // digital identity
          'username', 'ip_address', 'account_id', 'sensitive_account_id',
          // secrets / credentials
          'password', 'secret', 'api_key', 'access_token', 'recovery_code',
          // sensitive dates
          'sensitive_date', 'document_date', 'expiration_date', 'transaction_date',
        ],
        // The six moderation tasks, verbatim from the GLiGuard card — the
        // same schema `gliguard-llm-guardrails-300m` serves, so a selection can
        // move between the two rows without a policy rewrite.
        benignLabels: ['benign', 'safe', 'compliance'],
        tasks: {
          prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          prompt_toxicity: {
            labels: [
              'violence_and_weapons', 'non_violent_crime', 'sexual_content',
              'hate_and_discrimination', 'self_harm_and_suicide', 'pii_exposure',
              'misinformation', 'copyright_violation', 'child_safety',
              'political_manipulation', 'unethical_conduct', 'regulated_advice',
              'privacy_violation', 'other', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          jailbreak_detection: {
            labels: [
              'prompt_injection', 'jailbreak_attempt', 'policy_evasion',
              'instruction_override', 'system_prompt_exfiltration', 'data_exfiltration',
              'roleplay_bypass', 'hypothetical_bypass', 'obfuscated_attack',
              'multi_step_attack', 'social_engineering', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          response_toxicity: {
            labels: [
              'violence_and_weapons', 'non_violent_crime', 'sexual_content',
              'hate_and_discrimination', 'self_harm_and_suicide', 'pii_exposure',
              'misinformation', 'copyright_violation', 'child_safety',
              'political_manipulation', 'unethical_conduct', 'regulated_advice',
              'privacy_violation', 'other', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_refusal: { labels: ['refusal', 'compliance'], multi_label: false },
        },
      },
    },
  },
  {
    id: '80000000-0000-0000-0007-000000000025',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GLiGuard LLM Guardrails 300M',
    slug: 'gliguard-llm-guardrails-300m',
    description:
      'fastino/gliguard-LLMGuardrails-300M — GLiNER2 multi-task LLM safety moderation. Platform default for guardrail.safety. Six tasks: prompt_safety, prompt_toxicity, jailbreak_detection, response_safety, response_toxicity, response_refusal.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'fastino/gliguard-LLMGuardrails-300M',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: 'gliner2',
    memorySizeMb: 1024,
    computeType: 'float32',
    tags: ['guardrail', 'safety', 'moderation', 'gliner2'],
    metaData: {
      // Model card: English only. The two PII rows are 7-language, so a future
      // multilingual safety requirement CANNOT be met by this checkpoint — the
      // limit is recorded on the row rather than discovered in production.
      languages: ['en'],
      // Classification ONLY — no entity extraction (model card, confirmed
      // against the weights). Never select this row for `guardrail.pii`.
      capabilities: ['classify_text'],
      labelTaxonomy: {
        threshold: 0.4,
        // Labels that mean "clean" and must never be reported as an issue.
        benignLabels: ['benign', 'safe', 'compliance'],
        // Task names are the model's own schema keys; labels are verbatim from
        // the model card. Guardrail maps guardrail_type → subset of these.
        tasks: {
          prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          prompt_toxicity: {
            labels: [
              'violence_and_weapons', 'non_violent_crime', 'sexual_content',
              'hate_and_discrimination', 'self_harm_and_suicide', 'pii_exposure',
              'misinformation', 'copyright_violation', 'child_safety',
              'political_manipulation', 'unethical_conduct', 'regulated_advice',
              'privacy_violation', 'other', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          jailbreak_detection: {
            labels: [
              'prompt_injection', 'jailbreak_attempt', 'policy_evasion',
              'instruction_override', 'system_prompt_exfiltration', 'data_exfiltration',
              'roleplay_bypass', 'hypothetical_bypass', 'obfuscated_attack',
              'multi_step_attack', 'social_engineering', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          response_toxicity: {
            labels: [
              'violence_and_weapons', 'non_violent_crime', 'sexual_content',
              'hate_and_discrimination', 'self_harm_and_suicide', 'pii_exposure',
              'misinformation', 'copyright_violation', 'child_safety',
              'political_manipulation', 'unethical_conduct', 'regulated_advice',
              'privacy_violation', 'other', 'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_refusal: { labels: ['refusal', 'compliance'], multi_label: false },
        },
      },
    },
  },
  // MiniCheck groundedness model (was env-only:
  // GUARDRAIL_V2_GROUNDEDNESS_*). NLI/entailment fact-checker used by the
  // guardrail groundedness sensor; modelled as TEXT_CLASSIFICATION (the
  // closest existing ModelTaskType for a sequence-pair entailment head — there
  // is no dedicated NLI task type). Default for the `guardrail.groundedness`
  // AiTaskDefault. GGUF served by `apps/nlp` (TASK-735 Phase 6 moved it out of `apps/guardrail`, which now hosts no weights).
  {
    id: '80000000-0000-0000-0007-000000000018',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MiniCheck Flan-T5 Large (GGUF)',
    slug: 'minicheck-flan-t5-large',
    description:
      'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF — MiniCheck (Flan-T5 Large) groundedness/entailment fact-checker used by the guardrail groundedness sensor. Modelled as TEXT_CLASSIFICATION (closest fit for NLI/entailment).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'built-in',
    architecture: 'flan-t5',
    memorySizeMb: 1200,
    computeType: 'q6_k',
    tags: ['guardrail', 'groundedness', 'minicheck', 'nli'],
  },
  // explicit DISABLED placeholder for the `/classify/text`
  // document-type classifier. `nlp.classification` historically pointed at the
  // diagnosis suggester (symps-disease-bert), which is the WRONG model for the
  // doc-type endpoint. No real doc-type classifier is deployed yet, so
  // `nlp.classification` is repointed here and the capability is fail-closed
  // (a DISABLED row never resolves to an ENABLED model → 503) until a real
  // model is seeded. The diagnosis suggester moves to the new `nlp.diagnosis`
  // task key.
  {
    id: '80000000-0000-0000-0007-000000000019',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Document-Type Classifier (placeholder)',
    slug: 'nlp-doc-type-classifier',
    description:
      'Placeholder for the /classify/text document-type classifier. Seeded DISABLED: no doc-type model is deployed, so nlp.classification fails closed until a real classifier replaces this row.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'placeholder://nlp-doc-type-classifier',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'float32',
    tags: ['nlp', 'classification', 'placeholder', 'disabled'],
    resourceStatus: ResourceStatusType.DISABLED,
  },
];

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
    // `metaData.clinicalTaxonomy` is LOAD-BEARING, not documentation (TASK-799
    // lane G) — the same mechanism `labelTaxonomy` already uses on the guardrail
    // rows below. Until now these four lived inside `apps/nlp` as Python
    // literals (`ontology_linker._VOCABULARY_ENTRIES`, `vitals_extractor`'s
    // `_*_RANGE` constants, `assertion._TRIGGERS`) and as `TOKEN_CLASSIFIER_*` /
    // `NLP_LINKER_*` env fields, so widening clinical coverage or retuning a
    // plausibility band meant a redeploy. The gateway now resolves this blob
    // (`resolveNerModelInjection`, SYSTEM-pinned per decision D-4) and injects
    // it into every `/classify/tokens` call; `seedAiModels` re-syncs `metaData`
    // on re-seed, so a platform admin edit here propagates.
    //
    // Values are transcribed VERBATIM from the code they replace, so seeding
    // changes ZERO runtime behaviour. `apps/nlp` carries no fallback copy: an
    // absent section DISABLES the pass it governs (no ontology codes, no vitals,
    // no assertion labels) rather than substituting a literal.
    metaData: {
      clinicalTaxonomy: {
        tokenClassifier: {
          aggregationStrategy: 'simple',
          ignoreLabels: ['O'],
          assertionEnabled: true,
        },
        linker: {
          enabled: true,
          confidenceFloor: 0.0,
          vocabulary: [
            {
              aliases: ['metformin'],
              umls_cui: 'C0025598',
              rxnorm_code: '6809',
            },
            {
              aliases: ['aspirin', 'acetylsalicylic acid'],
              umls_cui: 'C0004057',
              rxnorm_code: '1191',
            },
            {
              aliases: ['amoxicillin'],
              umls_cui: 'C0002645',
              rxnorm_code: '723',
            },
            {
              aliases: ['amlodipine'],
              umls_cui: 'C0051696',
              rxnorm_code: '17767',
            },
            {
              aliases: ['lisinopril'],
              umls_cui: 'C0065374',
              rxnorm_code: '29046',
            },
            {
              aliases: ['metoprolol'],
              umls_cui: 'C0025859',
              rxnorm_code: '6918',
            },
            {
              aliases: ['atorvastatin'],
              umls_cui: 'C0286651',
              rxnorm_code: '83367',
            },
            {
              aliases: ['ibuprofen'],
              umls_cui: 'C0020740',
              rxnorm_code: '5640',
            },
            {
              aliases: ['insulin'],
              umls_cui: 'C0021641',
              rxnorm_code: '5856',
            },
            {
              aliases: ['warfarin'],
              umls_cui: 'C0043031',
              rxnorm_code: '11289',
            },
            {
              aliases: ['omeprazole'],
              umls_cui: 'C0028978',
              rxnorm_code: '7646',
            },
            {
              aliases: ['albuterol', 'salbutamol'],
              umls_cui: 'C0001927',
              rxnorm_code: '435',
            },
            {
              aliases: ['prednisone'],
              umls_cui: 'C0032952',
              rxnorm_code: '8640',
            },
            {
              aliases: ['furosemide'],
              umls_cui: 'C0016860',
              rxnorm_code: '4603',
            },
            {
              aliases: ['pneumonia'],
              umls_cui: 'C0032285',
              snomed_code: '233604007',
              icd_code: 'J18.9',
            },
            {
              aliases: ['hypertension', 'high blood pressure'],
              umls_cui: 'C0020538',
              snomed_code: '38341003',
              icd_code: 'I10',
            },
            {
              aliases: ['type 2 diabetes', 'type ii diabetes', 't2dm'],
              umls_cui: 'C0011860',
              snomed_code: '44054006',
              icd_code: 'E11.9',
            },
            {
              aliases: ['asthma'],
              umls_cui: 'C0004096',
              snomed_code: '195967001',
              icd_code: 'J45.909',
            },
            {
              aliases: ['copd', 'chronic obstructive pulmonary disease'],
              umls_cui: 'C0024117',
              snomed_code: '13645005',
              icd_code: 'J44.9',
            },
            {
              aliases: ['covid-19', 'covid', 'covid 19'],
              umls_cui: 'C5203670',
              snomed_code: '840539006',
              icd_code: 'U07.1',
            },
            {
              aliases: ['myocardial infarction', 'heart attack'],
              umls_cui: 'C0027051',
              snomed_code: '22298006',
              icd_code: 'I21.9',
            },
            {
              aliases: ['sepsis'],
              umls_cui: 'C0243026',
              snomed_code: '91302008',
              icd_code: 'A41.9',
            },
            {
              aliases: ['anemia', 'anaemia'],
              umls_cui: 'C0002871',
              snomed_code: '271737000',
              icd_code: 'D64.9',
            },
            {
              aliases: ['headache', 'cephalalgia'],
              umls_cui: 'C0018681',
              snomed_code: '25064002',
              icd_code: 'R51.9',
            },
            {
              aliases: ['fever', 'pyrexia'],
              umls_cui: 'C0015967',
              snomed_code: '386661006',
              icd_code: 'R50.9',
            },
            {
              aliases: ['chest pain'],
              umls_cui: 'C0008031',
              snomed_code: '29857009',
              icd_code: 'R07.9',
            },
            {
              aliases: ['cough'],
              umls_cui: 'C0010200',
              snomed_code: '49727002',
              icd_code: 'R05.9',
            },
            {
              aliases: ['nausea'],
              umls_cui: 'C0027497',
              snomed_code: '422587007',
              icd_code: 'R11.0',
            },
            {
              aliases: ['shortness of breath', 'dyspnea', 'dyspnoea', 'sob'],
              umls_cui: 'C0013404',
              snomed_code: '267036007',
              icd_code: 'R06.02',
            },
            {
              aliases: ['fatigue'],
              umls_cui: 'C0015672',
              snomed_code: '84229001',
              icd_code: 'R53.83',
            },
            {
              aliases: ['dizziness'],
              umls_cui: 'C0012833',
              snomed_code: '404640003',
              icd_code: 'R42',
            },
            {
              aliases: ['hemoglobin a1c', 'hba1c', 'a1c', 'glycated hemoglobin'],
              umls_cui: 'C0202054',
              loinc_code: '4548-4',
            },
            {
              aliases: ['glucose', 'blood glucose'],
              umls_cui: 'C0202041',
              loinc_code: '2345-7',
            },
            {
              aliases: ['creatinine'],
              umls_cui: 'C0201975',
              loinc_code: '2160-0',
            },
            {
              aliases: ['hemoglobin', 'haemoglobin', 'hgb'],
              umls_cui: 'C0518015',
              loinc_code: '718-7',
            },
            {
              aliases: ['potassium'],
              umls_cui: 'C0202194',
              loinc_code: '2823-3',
            },
            {
              aliases: ['white blood cell count', 'wbc'],
              umls_cui: 'C0023508',
              loinc_code: '6690-2',
            },
            {
              aliases: ['chest x-ray', 'chest xray', 'cxr'],
              umls_cui: 'C0039985',
              snomed_code: '399208008',
            },
            {
              aliases: ['electrocardiogram', 'ecg', 'ekg'],
              umls_cui: 'C0013798',
              snomed_code: '29303009',
            },
            {
              aliases: ['mri', 'magnetic resonance imaging'],
              umls_cui: 'C0024485',
              snomed_code: '113091000',
            },
          ],
        },
        vitals: {
          systolic: {
            min: 60,
            max: 260,
          },
          diastolic: {
            min: 30,
            max: 160,
          },
          heartRate: {
            min: 25,
            max: 220,
          },
          spo2: {
            min: 50,
            max: 100,
          },
          temperatureC: {
            min: 30.0,
            max: 44.0,
          },
          weightKg: {
            min: 1.0,
            max: 400.0,
          },
        },
        assertion: {
          triggers: {
            ABSENT: [
              'no evidence of',
              'no signs of',
              'no history of',
              'not been having',
              'absence of',
              'negative for',
              'free of',
              'without',
              'denies',
              'denied',
              'no',
              'not',
            ],
            FAMILY: [
              'family history of',
              'family hx of',
              'fhx',
              'mother',
              'father',
              'brother',
              'sister',
              'sibling',
              'parents',
              'maternal',
              'paternal',
              'familial',
            ],
            HYPOTHETICAL: [
              'rule out',
              'r/o',
              'return if',
              'call if',
              'come back if',
              'in case of',
              'possibility of',
              'possible',
              'concern for',
              'should there be',
              'if',
            ],
            HISTORICAL: ['history of', 'hx of', 'status post', 's/p', 'previous', 'previously', 'prior', 'past medical history', 'in the past'],
          },
        },
      },
    },
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
      // What `apps/nlp` may ask this checkpoint to do. Extraction ONLY — and
      // this list is LOAD-BEARING, not documentation, because the runtime will
      // NOT catch a mis-selection for us. Probed against the real weights
      // (2026-08-20): `classify_text` on this checkpoint does not raise, it
      // ANSWERS, and answers badly — it called a polite clinical question
      // "unsafe" at 0.77 confidence and a plain refusal "unsafe" at 0.998.
      // A `guardrail.safety` selection pointing here therefore produces
      // confident false positives, not an error. The catalog is the only gate.
      capabilities: ['extract_entities'],
      labelTaxonomy: {
        threshold: 0.5,
        // All 42 entity types from the model card, in its own grouping order.
        labels: [
          // person / names
          'person',
          'full_name',
          'first_name',
          'middle_name',
          'last_name',
          'date_of_birth',
          // contact / address
          'email',
          'phone_number',
          'address',
          'street_address',
          'city',
          'state_or_region',
          'postal_code',
          'country',
          // government / tax ids
          'government_id',
          'national_id_number',
          'passport_number',
          'drivers_license_number',
          'license_number',
          'tax_id',
          'tax_number',
          // banking / payment
          'bank_account',
          'account_number',
          'routing_number',
          'iban',
          'payment_card',
          'card_number',
          'card_expiry',
          'card_cvv',
          // digital identity
          'username',
          'ip_address',
          'account_id',
          'sensitive_account_id',
          // secrets / credentials
          'password',
          'secret',
          'api_key',
          'access_token',
          'recovery_code',
          // sensitive dates
          'sensitive_date',
          'document_date',
          'expiration_date',
          'transaction_date',
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
          'person',
          'full_name',
          'first_name',
          'middle_name',
          'last_name',
          'date_of_birth',
          // contact / address
          'email',
          'phone_number',
          'address',
          'street_address',
          'city',
          'state_or_region',
          'postal_code',
          'country',
          // government / tax ids
          'government_id',
          'national_id_number',
          'passport_number',
          'drivers_license_number',
          'license_number',
          'tax_id',
          'tax_number',
          // banking / payment
          'bank_account',
          'account_number',
          'routing_number',
          'iban',
          'payment_card',
          'card_number',
          'card_expiry',
          'card_cvv',
          // digital identity
          'username',
          'ip_address',
          'account_id',
          'sensitive_account_id',
          // secrets / credentials
          'password',
          'secret',
          'api_key',
          'access_token',
          'recovery_code',
          // sensitive dates
          'sensitive_date',
          'document_date',
          'expiration_date',
          'transaction_date',
        ],
        // The six moderation tasks. NOTE (probed 2026-08-20): these are NOT a
        // schema baked into the checkpoint — `gliner2.classify_text` BUILDS a
        // schema from the task names and labels the caller passes, and an empty
        // label list raises. So the taxonomy is caller-supplied configuration
        // end to end, which is exactly why it lives on this row.
        benignLabels: ['benign', 'safe', 'compliance'],
        tasks: {
          prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          prompt_toxicity: {
            labels: [
              'violence_and_weapons',
              'non_violent_crime',
              'sexual_content',
              'hate_and_discrimination',
              'self_harm_and_suicide',
              'pii_exposure',
              'misinformation',
              'copyright_violation',
              'child_safety',
              'political_manipulation',
              'unethical_conduct',
              'regulated_advice',
              'privacy_violation',
              'other',
              'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          jailbreak_detection: {
            labels: [
              'prompt_injection',
              'jailbreak_attempt',
              'policy_evasion',
              'instruction_override',
              'system_prompt_exfiltration',
              'data_exfiltration',
              'roleplay_bypass',
              'hypothetical_bypass',
              'obfuscated_attack',
              'multi_step_attack',
              'social_engineering',
              'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          response_toxicity: {
            labels: [
              'violence_and_weapons',
              'non_violent_crime',
              'sexual_content',
              'hate_and_discrimination',
              'self_harm_and_suicide',
              'pii_exposure',
              'misinformation',
              'copyright_violation',
              'child_safety',
              'political_manipulation',
              'unethical_conduct',
              'regulated_advice',
              'privacy_violation',
              'other',
              'benign',
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
      // Classification ONLY. Probed against the real weights (2026-08-20):
      // `extract_entities` does not raise either — it returns an EMPTY list for
      // every label, which on the redaction path is indistinguishable from
      // "scanned, found nothing". Selecting this row for `guardrail.pii` would
      // therefore silently disable redaction. Never do it.
      capabilities: ['classify_text'],
      labelTaxonomy: {
        threshold: 0.4,
        // Labels that mean "clean" and must never be reported as an issue.
        benignLabels: ['benign', 'safe', 'compliance'],
        // Task names are CALLER-SUPPLIED, not the model's own schema keys
        // (probed 2026-08-20 — `classify_text` conditions on whatever names and
        // labels it is handed). Labels are verbatim from the model card.
        // Guardrail maps guardrail_type → subset of these.
        tasks: {
          prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          prompt_toxicity: {
            labels: [
              'violence_and_weapons',
              'non_violent_crime',
              'sexual_content',
              'hate_and_discrimination',
              'self_harm_and_suicide',
              'pii_exposure',
              'misinformation',
              'copyright_violation',
              'child_safety',
              'political_manipulation',
              'unethical_conduct',
              'regulated_advice',
              'privacy_violation',
              'other',
              'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          jailbreak_detection: {
            labels: [
              'prompt_injection',
              'jailbreak_attempt',
              'policy_evasion',
              'instruction_override',
              'system_prompt_exfiltration',
              'data_exfiltration',
              'roleplay_bypass',
              'hypothetical_bypass',
              'obfuscated_attack',
              'multi_step_attack',
              'social_engineering',
              'benign',
            ],
            multi_label: true,
            cls_threshold: 0.4,
          },
          response_safety: { labels: ['safe', 'unsafe'], multi_label: false },
          response_toxicity: {
            labels: [
              'violence_and_weapons',
              'non_violent_crime',
              'sexual_content',
              'hate_and_discrimination',
              'self_harm_and_suicide',
              'pii_exposure',
              'misinformation',
              'copyright_violation',
              'child_safety',
              'political_manipulation',
              'unethical_conduct',
              'regulated_advice',
              'privacy_violation',
              'other',
              'benign',
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
    // `metaData.entailment` is the CALIBRATION GATE's ground truth (TASK-799
    // lane G). `apps/nlp` runs this checkpoint through a fail-closed self-check
    // before it is allowed to score a clinical groundedness gate; the bounds and
    // the reference pair used to be module constants there, which meant they
    // described THIS Q6 build while applying to whatever checkpoint
    // `guardrail.groundedness` happened to select. They belong on the row
    // because they are a property of the build AND its quantisation.
    //
    // `adapter` is a BINDING, not a knob: `apps/nlp` implements exactly
    // `minicheck-flan-t5` (the `'predict: '` template plus the 3/209 label-token
    // logit read) and REFUSES a row declaring anything else, so re-pointing this
    // task at a non-MiniCheck NLI model now fails closed to `unverified` instead
    // of returning plausible-looking numbers read out of the wrong vocabulary.
    // `labelTokenNo`/`labelTokenYes` are asserted against the adapter's own ids
    // for the same reason. Values transcribed verbatim from the code they
    // replace; reference probabilities are the published model card's
    // (~0.981 supported / ~0.007 unsupported), and the tolerances are
    // direction+margin so a correct-but-quantised scorer still passes.
    metaData: {
      entailment: {
        adapter: 'minicheck-flan-t5',
        labelTokenNo: 3,
        labelTokenYes: 209,
        supportedMin: 0.6,
        unsupportedMax: 0.4,
        document: 'A group of students gather in the school library to study for their upcoming final exams.',
        supportedClaim: 'The students are preparing for an examination.',
        unsupportedClaim: 'The students are on vacation.',
      },
    },
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

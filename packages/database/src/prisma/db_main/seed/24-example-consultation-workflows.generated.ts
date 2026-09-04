/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by `scripts/regen-example-consultation-workflow-seed.ts` from the REAL
 * `validate()` / `compile()` / `registryChecksum()` in `packages/workflow-contract`, against the
 * three graphs authored in `24-example-consultation-workflows.ts`.
 *
 * Every value here is engine output. Editing one by hand would assert a compiler verdict that
 * no compiler ever reached — and `task-858-example-consultation-workflows.test.ts` re-runs the
 * engine and compares, so the edit would fail CI rather than ship.
 *
 * To change any of it, change the GRAPH and re-run the script:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-example-consultation-workflow-seed.ts
 */

export const REGISTRY_CHECKSUM: string = "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc" as const;

export const GRAMMAR_FIX_GRAPH_CHECKSUM: string = "587578c368221b4212cbf8c580065ac41a1fa47029f3d8152544dbe8cbfdcb6b" as const;

export const GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "evaluatedAt": "2026-09-03T00:00:00.000Z"
} as const;

export const PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000001",
  "slug": "platform-consultation-grammar-fix",
  "versionNumber": 1,
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_grammar",
          "type": "agent.grammar",
          "activity": "interpreter.agent_grammar",
          "config": {
            "promptTemplateId": "71000000-0000-0000-0000-000000000043",
            "taskKey": "text.live",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        },
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade",
            "enabled": false
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_grammar",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "493ab7bb043185e5d16ca150ea21a336b5356ab2eb3d313c2147851343751b40"
} as const;

export const ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000011",
  "slug": "arcaai-consultation-grammar-fix",
  "versionNumber": 1,
  "tenantId": "50000000-0000-0000-0000-000000000001",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_grammar",
          "type": "agent.grammar",
          "activity": "interpreter.agent_grammar",
          "config": {
            "promptTemplateId": "71000000-0000-0000-0000-000000000043",
            "taskKey": "text.live",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        },
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade",
            "enabled": false
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_grammar",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "06181abe2dfb8c3b1a03de590f38e58e31a73bbb1ad374bf2f5e26c229f6d7ac"
} as const;

export const MEDICAL_NER_GRAPH_CHECKSUM: string = "fa5ea9f83c81f059af24ea7ccfbb4ba3601531baab2ac7c85051b3f60cd5655b" as const;

export const MEDICAL_NER_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "evaluatedAt": "2026-09-03T00:00:00.000Z"
} as const;

export const PLATFORM_MEDICAL_NER_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000002",
  "slug": "platform-consultation-medical-ner",
  "versionNumber": 1,
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "688b6f3d2e3f5761c9538052d27462ebbb048c53a069f849e8854871aaddbfa8"
} as const;

export const ARCAAI_MEDICAL_NER_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000012",
  "slug": "arcaai-consultation-medical-ner",
  "versionNumber": 1,
  "tenantId": "50000000-0000-0000-0000-000000000001",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "8b882f8b01dbaf8ecef90f28aadb61a17706e9d2bd50751bc94667b194abdf39"
} as const;

export const NER_GRAMMAR_FIX_GRAPH_CHECKSUM: string = "bbcccd033d624c5053636c3dd872ead001e056004de1a64edada3732d9fbcfc3" as const;

export const NER_GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "evaluatedAt": "2026-09-03T00:00:00.000Z"
} as const;

export const PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000003",
  "slug": "platform-consultation-ner-grammar-fix",
  "versionNumber": 1,
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_grammar",
          "type": "agent.grammar",
          "activity": "interpreter.agent_grammar",
          "config": {
            "promptTemplateId": "71000000-0000-0000-0000-000000000043",
            "taskKey": "text.live",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        },
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_grammar",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "930e6573484074d2655598e372aaf63c9dfeed0a15a4f61e181a6ed0aa5461a6"
} as const;

export const ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0003-000000000013",
  "slug": "arcaai-consultation-ner-grammar-fix",
  "versionNumber": 1,
  "tenantId": "50000000-0000-0000-0000-000000000001",
  "paletteKey": "consultation",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "417ead4b5af8d5a651580fcd04498a93724053f0adaaef8b393fda81afe6b1cc",
  "ruleSetVersion": 1,
  "stages": [
    {
      "stageIndex": 0,
      "nodes": [
        {
          "nodeId": "n_start",
          "type": "core.start",
          "activity": "interpreter.core_start",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 1,
      "nodes": [
        {
          "nodeId": "n_consent",
          "type": "consultation.consentGate",
          "activity": "interpreter.consultation_consent_gate",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_start",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 2,
      "nodes": [
        {
          "nodeId": "n_capture",
          "type": "consultation.captureBinding",
          "activity": "interpreter.consultation_capture_binding",
          "config": {
            "action": "start",
            "persistSnapshot": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_consent",
              "fromPort": "out",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_grammar",
          "type": "agent.grammar",
          "activity": "interpreter.agent_grammar",
          "config": {
            "promptTemplateId": "71000000-0000-0000-0000-000000000043",
            "taskKey": "text.live",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        },
        {
          "nodeId": "n_realtime",
          "type": "consultation.realtimeSummary",
          "activity": "interpreter.consultation_realtime_summary",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 4,
      "nodes": [
        {
          "nodeId": "n_entities",
          "type": "consultation.extractEntities",
          "activity": "interpreter.consultation_extract_entities",
          "config": {
            "language": "en",
            "persist": true,
            "requiresFinalized": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_grammar",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_realtime",
              "fromPort": "next",
              "toPort": "after"
            },
            {
              "fromNodeId": "n_capture",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_phi",
          "type": "consultation.phiHop",
          "activity": "interpreter.consultation_phi_hop",
          "config": {
            "mode": "pseudonymize",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_entities",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 6,
      "nodes": [
        {
          "nodeId": "n_prompt",
          "type": "consultation.assemblePrompt",
          "activity": "interpreter.consultation_assemble_prompt",
          "config": {
            "requiresFinalized": true,
            "conversationLanguage": "en",
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_phi",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 7,
      "nodes": [
        {
          "nodeId": "n_synth",
          "type": "consultation.synthesize",
          "activity": "interpreter.consultation_synthesize",
          "config": {
            "taskKey": "text.finalize",
            "producesCode": false,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_prompt",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 8,
      "nodes": [
        {
          "nodeId": "n_sensors",
          "type": "consultation.sensors",
          "activity": "interpreter.consultation_sensors",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_synth",
              "fromPort": "out",
              "toPort": "in"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 9,
      "nodes": [
        {
          "nodeId": "n_persist",
          "type": "consultation.persistDraft",
          "activity": "interpreter.consultation_persist_draft",
          "config": {
            "occ": true,
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_sensors",
              "fromPort": "document",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 10,
      "nodes": [
        {
          "nodeId": "n_assure",
          "type": "consultation.finalizeAssurance",
          "activity": "interpreter.consultation_finalize_assurance",
          "config": {
            "onError": "degrade"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_persist",
              "fromPort": "contextItemId",
              "toPort": "contextItemId"
            },
            {
              "fromNodeId": "n_persist",
              "fromPort": "out",
              "toPort": "in"
            },
            {
              "fromNodeId": "n_sensors",
              "fromPort": "out",
              "toPort": "verdict"
            }
          ],
          "onError": "degrade",
          "emitsTrajectory": true
        }
      ]
    },
    {
      "stageIndex": 11,
      "nodes": [
        {
          "nodeId": "n_end",
          "type": "core.end",
          "activity": "interpreter.core_end",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_gate",
              "fromPort": "next",
              "toPort": "after"
            }
          ],
          "onError": "fail",
          "emitsTrajectory": true
        }
      ]
    }
  ],
  "gates": [
    {
      "nodeId": "n_gate",
      "gateType": "clinician_review",
      "blocking": true,
      "timeoutSeconds": 3600,
      "onTimeout": "TIMED_OUT"
    }
  ],
  "policyBindings": {
    "guardrailProfile": "STANDARD",
    "redactionRuleSetId": null,
    "promptTemplateRefs": [],
    "documentTemplateRefs": [],
    "contextSchemaVersionId": null,
    "entitlementKeys": []
  },
  "caps": {
    "maxTotalSeconds": 3600,
    "maxNodeSeconds": 600,
    "maxAttempts": 5
  },
  "checksum": "70b835fb30ebea06e53a70e3539135c6a53af7f095a904eb2c1e081547c3ab04"
} as const;

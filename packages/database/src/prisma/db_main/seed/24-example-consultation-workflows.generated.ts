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

export const REGISTRY_CHECKSUM: string = "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916" as const;

export const GRAMMAR_FIX_GRAPH_CHECKSUM: string = "587578c368221b4212cbf8c580065ac41a1fa47029f3d8152544dbe8cbfdcb6b" as const;

export const GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "f25781b3f6793740d443a7442863270a8157ee82326fc7707b2f6ef260d0df88"
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "474311c52394ab6588050abac5d7a8d98b12e8b07aa892154cee5374d011a905"
} as const;

export const MEDICAL_NER_GRAPH_CHECKSUM: string = "fa5ea9f83c81f059af24ea7ccfbb4ba3601531baab2ac7c85051b3f60cd5655b" as const;

export const MEDICAL_NER_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "67e3e2df32771c69d1c67f934d16bd353bd9f145c30447ea817bc1e6129921c0"
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "1dc8205d81709c700f7668d3d83a9961466b373282a9df90202c55f44415b526"
} as const;

export const NER_GRAMMAR_FIX_GRAPH_CHECKSUM: string = "bbcccd033d624c5053636c3dd872ead001e056004de1a64edada3732d9fbcfc3" as const;

export const NER_GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "f99209d6a2536114da21e1a522099b774b0cabfbc3c8c137fb2275ddbffaa30b"
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
  "registryChecksum": "4bb7da74cf0d43e3d8cc8fcd2447aca50d1fe3043b3a58b1951d1546b5337916",
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
  "checksum": "679907725f7055346f2d730a9048061b62cedaf7cbe849f54a845b650ff4e401"
} as const;

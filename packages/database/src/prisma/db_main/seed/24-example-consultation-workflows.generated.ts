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

export const REGISTRY_CHECKSUM: string = "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881" as const;

export const GRAMMAR_FIX_GRAPH_CHECKSUM: string = "587578c368221b4212cbf8c580065ac41a1fa47029f3d8152544dbe8cbfdcb6b" as const;

export const GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 20,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "e6f40fa90711dc66a957734f6c2294493338fca01438ddeb85cb9d6f494c8fb1"
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 20,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "69fd80ea0bad897280793f5978abd44d0d0895280dc6f35c344514f8b6856e68"
} as const;

export const MEDICAL_NER_GRAPH_CHECKSUM: string = "fa5ea9f83c81f059af24ea7ccfbb4ba3601531baab2ac7c85051b3f60cd5655b" as const;

export const MEDICAL_NER_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "0baf21dc8c8dc434a476c3b804f3afec2dfd08bee5c3226e4f1d631f71e4c786"
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "43053f8703db36e76c0d9d8e7bf4f15c62fa7b09f5a6172b720607e03cfc4344"
} as const;

export const NER_GRAMMAR_FIX_GRAPH_CHECKSUM: string = "bbcccd033d624c5053636c3dd872ead001e056004de1a64edada3732d9fbcfc3" as const;

export const NER_GRAMMAR_FIX_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 20,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "e9bbf2cf1e17199b6235a964a2bbc10d9e08a7e46172033be981eb05dfbcac08"
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
  "registryChecksum": "74e1db0dfa06e263bf18e3674c4d431f07918fcaee4ec83b246a65ff5f4c0881",
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 30,
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
          "timeoutSeconds": 20,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 150,
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
          "timeoutSeconds": 30,
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
  "checksum": "337a2ecec0aeaab6f3376604853dd86c728a77985a13b5fc31b2d1fd537d88d7"
} as const;

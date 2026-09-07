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

export const GRAMMAR_FIX_GRAPH_CHECKSUM: string = "5cb273433337366894f579f9700066a19315e8040e7d420c6b445ce1d5d1a390" as const;

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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "7f02d3825b68a27097cefc1164317b0f193cc0daa714a9038057891246a745f5"
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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "983e099fe4bb28eba3a77caa17cc58a20897f1e4ea8bc3cbd4799d6dfcfb4065"
} as const;

export const MEDICAL_NER_GRAPH_CHECKSUM: string = "61946be664e752d93ccd12dacb87fb9c7d0c64851ca3b1ca6b31edd1d4f5577c" as const;

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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "4b73f5078e05efe21e48c20fca2629de6938dc3dacc2df77ca0c1aaa6a5b3570"
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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "717ba83e79f3035b6331876fc0a43b8f9e78a4f658c4c8f33bbbea0ff4cdcdcb"
} as const;

export const NER_GRAMMAR_FIX_GRAPH_CHECKSUM: string = "5dc918f6e28c3616311db4fb46c96e9c48780edb5d25b899be34bfd2853250bb" as const;

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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "920ef012f80b1cbb23f3dd6c4829e4efeb44365c0bbb9505f1bd3c200470969e"
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
            "onError": "degrade",
            "documentTemplateSlug": "soap_note"
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
  "checksum": "7f9c8dd1b9f356ad6ef2845d8235efb416a4b0eff900fff1d23de97ba28b6f52"
} as const;

/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by `scripts/regen-workflow-seeds.ts` (`pnpm --filter @arcaai/database seed:regen:workflows`)
 * from the REAL `validate()` / `compile()` / `registryChecksum()` / `publishFindings()` in
 * `packages/workflow-contract`, against the graphs authored in `29-arcaai-agents-and-workflows.ts`.
 *
 * Every value here is engine output. Editing one by hand would assert a compiler verdict that no
 * compiler ever reached — and `task-930-workflow-seeds.test.ts` re-runs the engine and compares.
 */
import type { GeneratedWorkflowBlob } from './28-workflow-library.generated';

export const REGISTRY_CHECKSUM: string = "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2";

export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "ARCAAI:arcaai-gen-consultation": {
    "graphChecksum": "c96cbc0ac7a4917a4188f27c191c642f8d7fe458bb44570eafa6dfcd1d9c3fe8",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000001",
      "slug": "arcaai-gen-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-gen-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-gen-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "b624b17527232f43eb561e59d3d9d4ad9bb36d556cae1a804d3001e6edd01452"
    }
  },
  "ARCAAI:arcaai-surg-consultation": {
    "graphChecksum": "b24f3a77fe6916eaaa2f0a3cb6c9774ea319890c1437c1a41e00d6a308a1e0c0",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000002",
      "slug": "arcaai-surg-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-surg-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-surg-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "0c3a6676c93c3d163a917caca8383f240826026267a359ac1b89f12d7cc1aa05"
    }
  },
  "ARCAAI:arcaai-rheum-consultation": {
    "graphChecksum": "40507b27a05e674cf05923983141fabc51832437fe31cd064d52ce8960583984",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000003",
      "slug": "arcaai-rheum-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-rheum-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-rheum-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "05c6dbbe402fe7e2742469317ca2cdd3d6e644477822d1e31933e4de38b2bf86"
    }
  },
  "ARCAAI:arcaai-neur-consultation": {
    "graphChecksum": "bc7f25b3c31b46efb0bd98e9d7dda0daa57461f86cb514570a2ceb906e034ee3",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000004",
      "slug": "arcaai-neur-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neur-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neur-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "d1d6e0b7bec932c7315bc609215e1ba8af1056319846776c658f94445334319c"
    }
  },
  "ARCAAI:arcaai-orth-consultation": {
    "graphChecksum": "a9301dbd5ec22ee0b70b9bb8f6265117df39771c1324a6cf981cf288e7342f8a",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000005",
      "slug": "arcaai-orth-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-orth-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-orth-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "850f5dcea708d1d6adc58391861bbff210882fc3e328937eddf68083312c6570"
    }
  },
  "ARCAAI:arcaai-heme-consultation": {
    "graphChecksum": "8c9b37e9dd2df8e9e369cccb49d793a99839ed78587f0e6295e9f8122cd23ab8",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000006",
      "slug": "arcaai-heme-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-heme-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-heme-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "7c3619b2f3c2b1b841bf6a0361a1e367f2ce23536875c97d2d4c85ab6b41d134"
    }
  },
  "ARCAAI:arcaai-bren-consultation": {
    "graphChecksum": "028418fc79e6f219c5f0975134d96c3f4d8996be83740d57c85a525831366fa5",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000007",
      "slug": "arcaai-bren-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-bren-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-bren-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "2259744c9d60d37fe931cc2c345d544348d3b4e578480b42711248f18bd16e1b"
    }
  },
  "ARCAAI:arcaai-derm-consultation": {
    "graphChecksum": "c14b73729d93cbf320385f54e5dfb4c1bd6aaca36e46fa228176d265f055a9df",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000008",
      "slug": "arcaai-derm-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-derm-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-derm-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "eead2fb55d3e7478b03ad611ec5902207d662221885dc12667463b00caf2636f"
    }
  },
  "ARCAAI:arcaai-diet-consultation": {
    "graphChecksum": "9a396227e2e88e423fdefbb0403f49949fca8c8dbfe38d3b42988a8689f10510",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000009",
      "slug": "arcaai-diet-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-diet-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-diet-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "e869a4b01551dbb0c035879ee9a26697f79c063b1bf3b579c223b5419d38fd1b"
    }
  },
  "ARCAAI:arcaai-neph-consultation": {
    "graphChecksum": "1321715a900e73c7d0276bcc4d8fe96875cda22045346bf0836ad0dbc25db407",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000010",
      "slug": "arcaai-neph-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neph-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neph-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "a3368a9f3daebd601287d5d8b4f99a5b95c1d84109bac4d933a9ce243cba015e"
    }
  },
  "ARCAAI:arcaai-sonc-consultation": {
    "graphChecksum": "9caf66aee3eeeae82f743ce9efbcb6a498096b88d5edd00b54ed8160a002db63",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "evaluatedAt": "2026-09-08T00:00:00.000Z"
    },
    "compiledConfig": {
      "formatVersion": 1,
      "definitionId": "99000000-0000-0000-0001-000000000011",
      "slug": "arcaai-sonc-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000001",
      "paletteKey": "core",
      "compiledAt": "2026-09-08T00:00:00.000Z",
      "compilerVersion": "0.1.0",
      "registryChecksum": "ab2a7ad768ba1aac1ca1599d6d4a8d7080a99effb31b7d937e406be6eabe53b2",
      "ruleSetVersion": 1,
      "stages": [
        {
          "stageIndex": 0,
          "nodes": [
            {
              "nodeId": "n_trigger",
              "type": "core.trigger",
              "activity": "interpreter.core_trigger",
              "config": {
                "kinds": [
                  "consultation",
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "work_note": {
                        "type": "object"
                      },
                      "case_note": {
                        "type": "object"
                      },
                      "attachment": {
                        "type": "object"
                      },
                      "context": {
                        "type": "object",
                        "properties": {
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ],
                            "description": "Whether this is a new / referral visit or a follow-up (revisit)."
                          },
                          "current_department": {
                            "type": "string",
                            "description": "The consultation's department name; `General` when unknown."
                          },
                          "language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`)."
                          },
                          "safe_age": {
                            "type": "string",
                            "description": "Patient age, or `Unknown`."
                          },
                          "safe_dob": {
                            "type": "string",
                            "description": "Patient date of birth, or `Unknown`."
                          },
                          "safe_gender": {
                            "type": "string",
                            "description": "Patient gender, or `Unknown`."
                          },
                          "formatted_previous_visits": {
                            "type": "string",
                            "description": "Previous-visit summaries as text; empty when none."
                          },
                          "formatted_vitals": {
                            "type": "string",
                            "description": "Recorded vitals as text, or `Not available`."
                          },
                          "chief_complaint": {
                            "type": "string",
                            "description": "The presenting complaint, when the client supplies one."
                          },
                          "conversation_language": {
                            "type": "string",
                            "description": "The consultation language code (`en`, `ml`) — the v1 name of `language`."
                          },
                          "ner_entities": {
                            "type": "string",
                            "description": "Medical entities extracted from the transcript, serialised; empty when none."
                          },
                          "clinician_notes": {
                            "type": "string",
                            "description": "The clinician's own working notes for this consultation."
                          },
                          "attachments": {
                            "type": "string",
                            "description": "Text extracted from the consultation attachments."
                          },
                          "doctor_highlights": {
                            "type": "string",
                            "description": "Passages the clinician highlighted during the consultation."
                          },
                          "safe_vitals": {
                            "type": "string",
                            "description": "Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`."
                          },
                          "formatted_test_results": {
                            "type": "string",
                            "description": "Test results as text; empty when none."
                          },
                          "language_name": {
                            "type": "string",
                            "description": "The consultation language by NAME (`English`, `Malayalam`)."
                          },
                          "pre_summary_text": {
                            "type": "string",
                            "description": "The pre-summary this generation builds on."
                          },
                          "prior_visit_summary": {
                            "type": "string",
                            "description": "The carried summary of the patient's previous visit, bounded."
                          },
                          "dna_style_text": {
                            "type": "string",
                            "description": "The doctor's resolved DNA writing style."
                          },
                          "style_DNA_doctor_department_surgery": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgery slot when the template declares it."
                          },
                          "style_DNA_doctor_department_medicine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the medicine slot when the template declares it."
                          },
                          "style_DNA_doctor_department_neurology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the neurology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_orthopedics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the orthopedics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_hematology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the hematology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_rheumatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the rheumatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dermatology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dermatology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_dietetics": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the dietetics slot when the template declares it."
                          },
                          "style_DNA_doctor_department_nephrology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the nephrology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_surgical_oncology": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the surgical oncology slot when the template declares it."
                          },
                          "style_DNA_doctor_department_breast_endocrine": {
                            "type": "string",
                            "description": "The doctor's DNA writing style, substituted into the breast endocrine slot when the template declares it."
                          }
                        },
                        "required": [
                          "visit_type",
                          "current_department",
                          "language",
                          "safe_age",
                          "safe_dob",
                          "safe_gender",
                          "formatted_previous_visits",
                          "formatted_vitals"
                        ]
                      }
                    }
                  }
                },
                "guardrail": {
                  "enabled": true
                }
              },
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
              "nodeId": "n_asr",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "realtime-transcription"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
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
              "nodeId": "n_ner",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "medical-ner"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_asr",
                  "fromPort": "transcript",
                  "toPort": "in"
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
              "nodeId": "n_visit",
              "type": "core.condition",
              "activity": "interpreter.core_condition",
              "config": {
                "branches": [
                  {
                    "key": "new_visit",
                    "label": "New / referral visit",
                    "when": "trigger.context.visit_type == 'new-visit'"
                  },
                  {
                    "key": "revisit",
                    "label": "Follow-up visit",
                    "when": "trigger.context.visit_type == 'revisit'"
                  }
                ]
              },
              "timeoutSeconds": 30,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 4,
          "nodes": [
            {
              "nodeId": "n_summary_new",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-sonc-summary-new-visit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "else"
                },
                {
                  "fromNodeId": "n_visit",
                  "handle": "new_visit"
                }
              ]
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-sonc-summary-revisit"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "degrade"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                },
                {
                  "fromNodeId": "n_ner",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "branchGuards": [
                {
                  "fromNodeId": "n_visit",
                  "handle": "revisit"
                }
              ]
            }
          ]
        },
        {
          "stageIndex": 5,
          "nodes": [
            {
              "nodeId": "n_finalize",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "casenote-finalization"
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
                },
                "guardrail": {
                  "enabled": true
                },
                "onError": "fail"
              },
              "timeoutSeconds": 300,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_summary_new",
                  "fromPort": "out",
                  "toPort": "in"
                },
                {
                  "fromNodeId": "n_summary_revisit",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 6,
          "nodes": [
            {
              "nodeId": "n_review",
              "type": "core.humanReview",
              "activity": "interpreter.core_human_review",
              "config": {
                "reviewType": "clinical_finalization",
                "instructions": "Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.",
                "assignRole": "DOCTOR",
                "timeoutSeconds": 3600,
                "allowEdit": true
              },
              "timeoutSeconds": 600,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        },
        {
          "stageIndex": 7,
          "nodes": [
            {
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse",
                  "socket"
                ],
                "outputSchema": {
                  "type": "object",
                  "required": [
                    "case_note",
                    "entities"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "entities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "label"
                        ],
                        "properties": {
                          "text": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string"
                          },
                          "start": {
                            "type": "integer"
                          },
                          "end": {
                            "type": "integer"
                          },
                          "score": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                },
                "onSchemaViolation": "fail"
              },
              "timeoutSeconds": 60,
              "retry": {
                "maximumAttempts": 1,
                "initialIntervalSeconds": 1,
                "backoffCoefficient": 2
              },
              "inputs": [
                {
                  "fromNodeId": "n_review",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "e9060c68-aa80-8959-8058-ff5753a4c10f",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "52fadc24-5c96-8df9-85f6-6a7967be25d1",
            "versionNumber": 1,
            "versionId": "e9060c68-aa80-8959-8058-ff5753a4c10f"
          }
        ],
        "guardrail": {
          "enabled": true
        }
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "checksum": "5ae5697b317efd497d21fe33accf73799980eadba979de3a22c69abdcc9c612f"
    }
  }
};

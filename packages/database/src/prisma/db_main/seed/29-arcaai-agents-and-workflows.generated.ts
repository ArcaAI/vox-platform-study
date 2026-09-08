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

export const REGISTRY_CHECKSUM: string = "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149";

export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "ARCAAI:arcaai-gen-consultation": {
    "graphChecksum": "71d5d60c4c73779cee84672a1329f0401ca22a0e2b2bf216f98315cfd6325c57",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "e04d49e5c233268524baa7aed6a84295f4b7eeab7580eec1065bb54213cf90e1"
    }
  },
  "ARCAAI:arcaai-surg-consultation": {
    "graphChecksum": "b884bbf7256bc8754bfc59961bcd367cc43323604f435e75bdc2dd120f277b80",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "c2d64bf55dda6f48e0885f009c4f82f25ab6d395708317ce42e3c78c7c1963d5"
    }
  },
  "ARCAAI:arcaai-rheum-consultation": {
    "graphChecksum": "03cdbf66269277795b587c920401b545d495e1ca61b169e795e671e1395c7bdf",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "ab9f5261fb8e242be004f7cf2dd44c1475f68d111793794563de77e3df7b3154"
    }
  },
  "ARCAAI:arcaai-neur-consultation": {
    "graphChecksum": "3a89b3bfed89afcafc2eae78e13d970d5249c99c8e4e0555e080748b12795bdb",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "a6c4838318019b7bf867f6ed53d3da917e35a02e5c7be21a0a3499f09dbb30c7"
    }
  },
  "ARCAAI:arcaai-orth-consultation": {
    "graphChecksum": "617d3e52f417d0b2f9119f99a89632b990e71d6b3167ede16e7297608f807edc",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "6aaf756199731b036d6a63ed8a1461b6d4c1465b63eaadf2d05d0c2902652331"
    }
  },
  "ARCAAI:arcaai-heme-consultation": {
    "graphChecksum": "9c6be078dc39d6cd52a096b5df39d9579cd80cf9e128cebf1c76020fb982aa95",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "92fbac7132554dce61f8104817bd05ab88cb1095f8971a55075f79c50c0f4a14"
    }
  },
  "ARCAAI:arcaai-bren-consultation": {
    "graphChecksum": "87d727947aca2057216b4617e301bda5dfd1b0b3327d7cff105d429eb9f5abba",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "d77b7d3999e0b5d0e49185d1ebc1484309ce69a966c1e7c4d1070e1a06702642"
    }
  },
  "ARCAAI:arcaai-derm-consultation": {
    "graphChecksum": "e930b7960aee49b893f5b72e8d0c6e97c2a24d8ca49510649584cda4081af548",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "7f4b6f92f9e2bcf81562de37899045e5e6a70cf2293add249ea107b98e145bdc"
    }
  },
  "ARCAAI:arcaai-diet-consultation": {
    "graphChecksum": "15d49681eabefc7717f4dda32e29364da97127dadc1a1c39c65ebe1df65222c4",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "e7a9f04ff6186320a8751755df1578f7d554d9cfe804513cec706eeed99014ee"
    }
  },
  "ARCAAI:arcaai-neph-consultation": {
    "graphChecksum": "51e46e7582c52f686ccc640e8ace7b514070902d208061d46d6e1d4876fc6751",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "954b18162aa9a46cb88eaff9ded8794549f429f880440f3d9222f8bf6c11ee6a"
    }
  },
  "ARCAAI:arcaai-sonc-consultation": {
    "graphChecksum": "8f86fd1e5cf203cd228c2a198dd90eb61160aef67eefdcaf2fda0ec4769fe6fc",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
      "registryChecksum": "b7f556b38bba350d4befc623675cc55393abf9b62307552c57709e0f57a9d149",
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
                    "case_note"
                  ],
                  "properties": {
                    "case_note": {
                      "type": "string"
                    },
                    "redactions": {
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_finalize",
                  "fromPort": "data",
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
      "checksum": "fdf4a0257e1bf296b25e09283e1b56d69d105d9b5d007130ffeadcd453df9331"
    }
  }
};

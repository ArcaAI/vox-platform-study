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

export const REGISTRY_CHECKSUM: string = "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc";

export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "ARCAAI:arcaai-gen-consultation": {
    "graphChecksum": "59218e01d613833fd2921ec0a1176bc11af8ac04defc1a0873b012da23f1ab72",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-gen-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-gen-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "b894ef83909eab03f33f2c01284182ff897f6dea123600d9cd19f1783671cd45"
    }
  },
  "ARCAAI:arcaai-surg-consultation": {
    "graphChecksum": "a8088c038fdd6d1a098a49bb59054ff4c74950c2fd96ef7d097c9c69730167b4",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-surg-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-surg-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "ec2a6c64481a6c4c8d8bfbe8495d0a35eaa08041c46f5d10c8dd5e3db9e301eb"
    }
  },
  "ARCAAI:arcaai-rheum-consultation": {
    "graphChecksum": "18b09f35398a148fc4a65fdce2f99d8e6bb718a9b78999e96754213e3865ee5c",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-rheum-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-rheum-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "cd149d556c4b93a99f49704ba59ac735f1bdc3f33adc8b0aa5be7d6874638fc7"
    }
  },
  "ARCAAI:arcaai-neur-consultation": {
    "graphChecksum": "837d535580b610db83748f717ecca0b2ddf210259008f03a3a9f28f3c14f0b06",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-neur-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-neur-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "5d0b4b2e3e90658feb5f1c1ee514e55a1be7eeeecf78883b9e601ea9563166c0"
    }
  },
  "ARCAAI:arcaai-orth-consultation": {
    "graphChecksum": "4342a42d2377909775b186e279974e92e4d05e6ec2f3a0746a0d33de9bdadc89",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-orth-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-orth-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "85beb3f13168696dd3bfa6ce7a77a90d314b342b0e5d45a3f3b2fcf1823f7e24"
    }
  },
  "ARCAAI:arcaai-heme-consultation": {
    "graphChecksum": "6626b0dabaa3025b704fd741d82449fb0e882d865c239e2d3ef2d5ca9c2c7e35",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-heme-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-heme-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "ab282e213dfc7a38f2cbb692fdfc8338c50073c73bcd39f5d53ede67faf9e321"
    }
  },
  "ARCAAI:arcaai-bren-consultation": {
    "graphChecksum": "a005a35fe9c401543ddf46f53ddafac6ca69eb85061d8d7d18fafe173788fbfa",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-bren-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-bren-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "0a4542c9fd800ae92d55b86b171d86e869cfe497ef13b10636f86e796752c051"
    }
  },
  "ARCAAI:arcaai-derm-consultation": {
    "graphChecksum": "3d9b4b8a29814b18700bad278496b354b0f8bede58808a94d334df4467e5a698",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-derm-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-derm-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "0567cd4615b3c8cd9aef1a09882413f448664d16d0202ac42407af45e6866304"
    }
  },
  "ARCAAI:arcaai-diet-consultation": {
    "graphChecksum": "80761b4a451d70e4ed87fc715c2c822ae0c35593c9badc5b8ac4b48b6b85feb3",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-diet-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-diet-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "49582c77e230aafef5c6d329fd6ff4083f71cd235a8bcbd9cf89a53f143dd85d"
    }
  },
  "ARCAAI:arcaai-neph-consultation": {
    "graphChecksum": "d482b918dcdc8d0665b7a22cba83e943454b6385306bbf22f28a8169d8f7ec37",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-neph-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-neph-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "d3f05b7f55f68c636bd41dd5c515423af7404a05e69556d470bd90f30fa01904"
    }
  },
  "ARCAAI:arcaai-sonc-consultation": {
    "graphChecksum": "a5d7a54b03447b9e69d74212ad2ebfb465640d5e50832a8f037925cae2030815",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
      "registryChecksum": "e5a5e4844ae5bf48cf002182735b8208065f0bba93250b0ce917e5c700c5b9fc",
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
                  "contextSchemaId": "79000000-0000-0000-0001-000000000021",
                  "versionNumber": 1,
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object"
                      },
                      "encounter": {
                        "type": "object",
                        "properties": {
                          "doctor_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The clinician's staff identifier (ALaaS consultantId)."
                          },
                          "event_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The external encounter/event id."
                          },
                          "department_code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Department code as registered in HOPE (GEN, BREN, …)."
                          },
                          "department_name": {
                            "type": "string",
                            "description": "Display name; informational."
                          },
                          "visit_type": {
                            "type": "string",
                            "enum": [
                              "new-visit",
                              "revisit"
                            ]
                          }
                        },
                        "required": [
                          "doctor_id",
                          "event_id",
                          "department_code",
                          "visit_type"
                        ]
                      },
                      "vitals": {
                        "type": "object",
                        "properties": {
                          "bloodPressure": {
                            "type": "string",
                            "description": "Systolic/diastolic, e.g. \"128/82\"."
                          },
                          "heartRate": {
                            "type": "number",
                            "description": "Beats per minute."
                          },
                          "respiratoryRate": {
                            "type": "number",
                            "description": "Breaths per minute."
                          },
                          "temperature": {
                            "type": "number",
                            "description": "Degrees Celsius."
                          },
                          "oxygenSaturation": {
                            "type": "number",
                            "description": "SpO2 as a percentage."
                          },
                          "weightKg": {
                            "type": "number"
                          },
                          "heightCm": {
                            "type": "number"
                          },
                          "bmi": {
                            "type": "number"
                          },
                          "bloodGlucose": {
                            "type": "number",
                            "description": "mg/dL."
                          },
                          "painScore": {
                            "type": "integer",
                            "description": "0-10."
                          },
                          "recordedAt": {
                            "type": "string",
                            "description": "ISO-8601 timestamp of the observation set."
                          },
                          "notes": {
                            "type": "string"
                          }
                        }
                      },
                      "previous_case_notes": {
                        "type": "object",
                        "properties": {
                          "notes": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "date": {
                                  "type": "string"
                                },
                                "department": {
                                  "type": "string"
                                },
                                "doctor": {
                                  "type": "string"
                                },
                                "title": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "text"
                              ]
                            }
                          }
                        },
                        "required": [
                          "notes"
                        ]
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
            },
            {
              "nodeId": "n_presummary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "case-notes-pre-summary"
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
                  "fromPort": "next",
                  "toPort": "after"
                },
                {
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "context"
                }
              ],
              "onError": "degrade",
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-sonc-soap-new-visit"
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
                "onError": "degrade",
                "documentTemplateSlug": "arcaai-sonc-soap-revisit"
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
                "dna": {
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
                  "fromNodeId": "n_presummary",
                  "fromPort": "next",
                  "toPort": "after"
                },
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
        "contextSchemaVersionId": "89000000-0000-0000-0001-000000000021",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0001-000000000021",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0001-000000000021"
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
      "checksum": "6606a8492fc017d3755361289200d251919bd3494d670ff2a6f2f3a94197d304"
    }
  }
};

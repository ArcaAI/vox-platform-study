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

export const REGISTRY_CHECKSUM: string = "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b";

export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "ARCAAI:arcaai-gen-consultation": {
    "graphChecksum": "f19ffe71af293e5d2f896df3129f644a455133e1ea8d695266e17985a29c7b90",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "1d041a8e15c9662c947b3f5b9b7be091d93a6440977c7396c0605c363f8e82fa"
    }
  },
  "ARCAAI:arcaai-surg-consultation": {
    "graphChecksum": "4162557e1f6e073207bfae4331932dfac4a0603748778bf7bd7a1eac3b6b03c6",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "8b37b2f53e5f7e5208b75bd611155362a89fb1e289e101e0274bd148715c45be"
    }
  },
  "ARCAAI:arcaai-rheum-consultation": {
    "graphChecksum": "b73f36717e6848b1fe794813160e14531eb9f9c137b0bcb550e74490f9148c1a",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "5e205426cdf5d5f7fcbd8b5fb34a0f2b425f1ce0d5e754056cb5cd0e86be5058"
    }
  },
  "ARCAAI:arcaai-neur-consultation": {
    "graphChecksum": "677ebede5807e4e55907b74c36dd41a5aca3952527d155a90b0acaf9c83d360d",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "ef1bc6042503110b6037b3e973ec77ac7be76cdea3f826bd51ae58613d7a2c36"
    }
  },
  "ARCAAI:arcaai-orth-consultation": {
    "graphChecksum": "dfb5f940a685b4177bd25b6606f72a7fc3b82108a5ac27a308c29f4ebfe4fd51",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "b6234805fc486e9d983966283faa4a2b5841863d34931843647e9115e49463f7"
    }
  },
  "ARCAAI:arcaai-heme-consultation": {
    "graphChecksum": "ad321a552dd7baa112ac1f42ebcdd5c4f47324012f00ec97d82e1063cff36d34",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "570aedccc8492447bad101862c3bf95ea4d1871b77bd0038f792da4d61a993eb"
    }
  },
  "ARCAAI:arcaai-bren-consultation": {
    "graphChecksum": "049989fbb8c52f6bd9190cfe99cdfd8bfb0c74651f026145ecc06c03c538bea3",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "e5dc7ffa5fd8ffc9fb88724b5e3d802ed0ca4feb832da7e59602ac24e93c072b"
    }
  },
  "ARCAAI:arcaai-derm-consultation": {
    "graphChecksum": "a59c6e7d1751645abff7b3081d1b42fe4517625835fc9d0265c5bfda71195390",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "c58275264e783f0090cf6faa90f10b91e083c2950a250448fdf9c99e61fdd510"
    }
  },
  "ARCAAI:arcaai-diet-consultation": {
    "graphChecksum": "5491381398ed8f449e77a63bf5ab75eb352e30efe77efd7d76c9e2b7e32e772b",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "d64c87489630484daf712ed1df33f5766c7305f9a1b05afc5f771db5368aaaa6"
    }
  },
  "ARCAAI:arcaai-neph-consultation": {
    "graphChecksum": "b9d7a8276372b9ef688081c8ed1d825d0251efef5b9851ff69e6b20f420a6543",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "733e3817c1c0b46cfc25f8fad0b2dbcd17fa97f7bb4a1425610e4816f168eacf"
    }
  },
  "ARCAAI:arcaai-sonc-consultation": {
    "graphChecksum": "0bfde0bdf12b074250de8c0a3221572ffb671c602e88621862564fb2e251b1b1",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
      "registryChecksum": "1fd34165ccfa9a783d52e3b08285280796fc7a0d3bc615e68741a468d2811a7b",
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
                  },
                  "followsLatest": true
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
      "checksum": "036e13c5bfa6f8f6847a7f48106e61145da0fc35ae095ef27cc7e07333f43d7e"
    }
  }
};

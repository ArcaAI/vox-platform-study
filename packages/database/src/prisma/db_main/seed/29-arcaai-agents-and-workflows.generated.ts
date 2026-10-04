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

export const REGISTRY_CHECKSUM: string = "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1";

export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "ARCAAI:arcaai-gen-consultation": {
    "graphChecksum": "b2f25b7d04a072ccb1fe474c45d224891fa434fe7665f6c8b940d9ab38c2f409",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-gen-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-gen-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000012",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000013",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "2c07e39a650fcebac765a9c7780c26263424017c3a842a4ef41cc0b128b397ad"
    }
  },
  "ARCAAI:arcaai-surg-consultation": {
    "graphChecksum": "81e65aa995d1ce013d04dda8563af23018434b9ec59dc8d85d3791cf8d46053d",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-surg-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-surg-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000010",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000011",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "f04a5062c4399109e468b48d88828f581ee62aab39201d463d2f1062fb308394"
    }
  },
  "ARCAAI:arcaai-rheum-consultation": {
    "graphChecksum": "0561d5527d820c81daeca0f875ee9597945f5578dd441f0347147ad237cc86d6",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-rheum-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-rheum-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000014",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000015",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "4914293bb6ef22c0bbc578402c8d75641fe3e26725f48358f9efa24f5f1f2704"
    }
  },
  "ARCAAI:arcaai-neur-consultation": {
    "graphChecksum": "089419b517e426d1b253849561f0d73eb9f4f018bd266ea247526d854c3dfc45",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-neur-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neur-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000016",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000017",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "4f77ef102e77a19eb4e25b1f03b9c89a67ea4a8f2eec3622aef53a33ba2f4309"
    }
  },
  "ARCAAI:arcaai-orth-consultation": {
    "graphChecksum": "660413574e7d3646f45d1aecd74f73f455ccd7b920c73eba774f558a161f1a7d",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-orth-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-orth-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000018",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000019",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "e6e5909aa365d79ef1181036c09e91fbeb94316762ab51d20100a9be45ec2b33"
    }
  },
  "ARCAAI:arcaai-heme-consultation": {
    "graphChecksum": "30ac5fcf00fb63d4fae4df7b5e7dfca25d85c5472c2ea3e6bf629f44933175c9",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-heme-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-heme-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000020",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000021",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "28c27c542771ec826ae1a92a1c821413cd9b8191e432f56bbd8971cc545a8e01"
    }
  },
  "ARCAAI:arcaai-bren-consultation": {
    "graphChecksum": "e5fc8604db082642b73db4b15713ec0571c78482174210177d4a506cd6955222",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-bren-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-bren-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000022",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000023",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "7aeaeabda5d7da630278e6a54b3768a87036ba259f8053c2099035746176eb67"
    }
  },
  "ARCAAI:arcaai-derm-consultation": {
    "graphChecksum": "8ed2421262cd795fdf607e50ea2d853b9e34cb6aff06b757d4128d91e79dcd8d",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-derm-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-derm-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000025",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000026",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "1732be647abd3df71a352e951db6730c44f8461ac6ba8f142476c26ffb84d901"
    }
  },
  "ARCAAI:arcaai-diet-consultation": {
    "graphChecksum": "92cc785b81cd3684655bbb206ec864c1f04f7f17046fe2e1b398f297735e3117",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-diet-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-diet-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000027",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000028",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "d7c0ebc1a04d34ab488cce95f9d1325161b378d7567a963bb65f66e096ff953a"
    }
  },
  "ARCAAI:arcaai-neph-consultation": {
    "graphChecksum": "ec9c6b7120a752a97a31901a1dccb64cdd9d0cbf6638bd0defd4d9b5b17b53d3",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-neph-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-neph-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000029",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000030",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "ce8fee78ea9c9011aaea9a48c3e1d3319f96486a1d6320d0a81896356b676cd7"
    }
  },
  "ARCAAI:arcaai-sonc-consultation": {
    "graphChecksum": "ce77782f4ca61ecc2c3cab85e9763df132ff1f2ec14927fef44bc156a979c5df",
    "validationReport": {
      "reportVersion": 1,
      "ok": true,
      "findings": [],
      "ruleSetVersion": 1,
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
      "registryChecksum": "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1",
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
                      "transcript": {
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
                      "investigations": {
                        "type": "object",
                        "properties": {
                          "results": {
                            "type": "array",
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "required": [
                                "name",
                                "value"
                              ],
                              "properties": {
                                "name": {
                                  "type": "string",
                                  "maxLength": 200
                                },
                                "value": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "unit": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "refRange": {
                                  "type": "string",
                                  "maxLength": 80
                                },
                                "collectedAt": {
                                  "type": "string",
                                  "maxLength": 40
                                },
                                "flag": {
                                  "type": "string",
                                  "maxLength": 20
                                }
                              },
                              "additionalProperties": false
                            }
                          }
                        },
                        "additionalProperties": false
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
                          "dna_redaction_rules_text": {
                            "type": "string",
                            "description": "The doctor's DNA redaction/rewrite rules as a bullet list (`Never write …`, `Always write … as …`); empty when the redaction gate is off or none are authored."
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
                  "slug": "realtime-transcription",
                  "versionNumber": 1
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
                  "slug": "case-notes-pre-summary",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "onStart"
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
              "emitsTrajectory": true,
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
            },
            {
              "nodeId": "n_transcript",
              "type": "core.data",
              "activity": "interpreter.core_data",
              "config": {
                "mappings": [
                  {
                    "from": "in.transcript.text",
                    "to": "text"
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
                  "fromNodeId": "n_trigger",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_trigger.outputs.context"
                }
              }
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
                  "slug": "medical-ner",
                  "versionNumber": 1
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
                },
                {
                  "fromNodeId": "n_transcript",
                  "fromPort": "text",
                  "toPort": "in"
                }
              ],
              "onError": "degrade",
              "emitsTrajectory": true,
              "bindings": {
                "text": {
                  "firstOf": [
                    "nodes.n_transcript.outputs.text",
                    "nodes.n_asr.outputs.transcript"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "arcaai-sonc-summary-new-visit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
            },
            {
              "nodeId": "n_summary_revisit",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "arcaai-sonc-summary-revisit",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "realtime",
                  "cadence": "perTurn"
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
              ],
              "bindings": {
                "context": {
                  "from": "nodes.n_trigger.outputs.context"
                },
                "message": {
                  "from": "nodes.n_ner.outputs.text"
                }
              }
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
                  "slug": "casenote-finalization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "onEnd"
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
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "firstOf": [
                    "nodes.n_summary_revisit.outputs.text",
                    "nodes.n_summary_new.outputs.text"
                  ]
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.text"
                }
              }
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
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_finalize.outputs.data"
                }
              }
            }
          ]
        }
      ],
      "gates": [],
      "policyBindings": {
        "guardrailProfile": "STANDARD",
        "redactionRuleSetId": null,
        "promptTemplateRefs": [
          {
            "nodeId": "n_presummary",
            "templateId": "71000000-0000-0000-0001-000000000024",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000031",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_new",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000032",
            "versionNumber": 3
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary_revisit",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000034",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0001-000000000033",
            "versionNumber": 1
          }
        ],
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
        ]
      },
      "caps": {
        "maxTotalSeconds": 3600,
        "maxNodeSeconds": 600,
        "maxAttempts": 5
      },
      "settings": {
        "connections": [
          "api",
          "sse",
          "socket"
        ],
        "sources": [
          "consultation"
        ]
      },
      "checksum": "e36dd31cb3b7e722f12fb8b6a95c507f5b88ec0db4f29265d34c4aa0c1fdf5ff"
    }
  }
};

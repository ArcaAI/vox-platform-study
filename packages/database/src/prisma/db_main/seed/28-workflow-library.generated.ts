/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by `scripts/regen-workflow-seeds.ts` (`pnpm --filter @arcaai/database seed:regen:workflows`)
 * from the REAL `validate()` / `compile()` / `registryChecksum()` / `publishFindings()` in
 * `packages/workflow-contract`, against the graphs authored in `28-workflow-library.ts`.
 *
 * Every value here is engine output. Editing one by hand would assert a compiler verdict that no
 * compiler ever reached — and `task-930-workflow-seeds.test.ts` re-runs the engine and compares.
 */
export interface GeneratedWorkflowBlob {
  graphChecksum: string;
  validationReport: Record<string, unknown>;
  compiledConfig: Record<string, unknown>;
}

export const REGISTRY_CHECKSUM: string = "52a0cfd5613bd1b9f708908a5ac6d62c819367be67f685cf94efe52738fec8e1";

export const WORKFLOW_LIBRARY_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = {
  "GLOBAL:general-medicine-consultation": {
    "graphChecksum": "84ce5e90ecd43fcfdccc97ea8d44f7359ca4bdd717feb8779b85d74bc930c0eb",
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
      "definitionId": "99000000-0000-0000-0002-000000000002",
      "slug": "general-medicine-consultation",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000000",
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
                  "contextSchemaId": "79000000-0000-0000-0000-000000000001",
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object",
                        "properties": {
                          "sttSessionId": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "transcript": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          }
                        ]
                      },
                      "work_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "case_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "attachment": {
                        "anyOf": [
                          {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                              "mediaId": {
                                "type": "string",
                                "minLength": 1
                              },
                              "mime": {
                                "type": "string",
                                "minLength": 1
                              },
                              "name": {
                                "type": "string"
                              },
                              "size": {
                                "type": "integer",
                                "minimum": 0
                              }
                            },
                            "required": [
                              "mediaId",
                              "mime"
                            ]
                          },
                          {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "additionalProperties": false,
                              "properties": {
                                "mediaId": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "mime": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "name": {
                                  "type": "string"
                                },
                                "size": {
                                  "type": "integer",
                                  "minimum": 0
                                }
                              },
                              "required": [
                                "mediaId",
                                "mime"
                              ]
                            }
                          }
                        ]
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
              "nodeId": "n_summary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "general-medicine-summarization",
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
          "stageIndex": 4,
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
                "onError": "fail",
                "timeoutSeconds": 600
              },
              "timeoutSeconds": 600,
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
                  "fromNodeId": "n_summary",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "from": "nodes.n_summary.outputs.text"
                }
              }
            }
          ]
        },
        {
          "stageIndex": 5,
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
          "stageIndex": 6,
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
            "templateId": "71000000-0000-0000-0000-000000000040",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0000-000000000051",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0000-000000000052",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0000-000000000052",
            "versionNumber": 1
          }
        ],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "89000000-0000-0000-0000-000000000001",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0000-000000000001",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0000-000000000001"
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
      "checksum": "4ebff11469176083e8c062d5ba955bef8c2ba0bca314692b432ff22b486a4ce1"
    }
  },
  "GLOBAL:platform-default-summarization": {
    "graphChecksum": "5da61a6451654f0c7b1e0588c640f1817aba2b0d25fe9466db09ee862f11a8f3",
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
      "definitionId": "99000000-0000-0000-0002-000000000001",
      "slug": "platform-default-summarization",
      "versionNumber": 1,
      "tenantId": "50000000-0000-0000-0000-000000000000",
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
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "79000000-0000-0000-0000-000000000001",
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object",
                        "properties": {
                          "sttSessionId": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "transcript": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          }
                        ]
                      },
                      "work_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "case_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "attachment": {
                        "anyOf": [
                          {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                              "mediaId": {
                                "type": "string",
                                "minLength": 1
                              },
                              "mime": {
                                "type": "string",
                                "minLength": 1
                              },
                              "name": {
                                "type": "string"
                              },
                              "size": {
                                "type": "integer",
                                "minimum": 0
                              }
                            },
                            "required": [
                              "mediaId",
                              "mime"
                            ]
                          },
                          {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "additionalProperties": false,
                              "properties": {
                                "mediaId": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "mime": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "name": {
                                  "type": "string"
                                },
                                "size": {
                                  "type": "integer",
                                  "minimum": 0
                                }
                              },
                              "required": [
                                "mediaId",
                                "mime"
                              ]
                            }
                          }
                        ]
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
              "nodeId": "n_summary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "general-medicine-summarization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "once"
                },
                "onError": "fail",
                "timeoutSeconds": 600
              },
              "timeoutSeconds": 600,
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
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "context": {
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
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse"
                ],
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
                  "fromNodeId": "n_summary",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_summary.outputs.text"
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
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0000-000000000051",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0000-000000000052",
            "versionNumber": 1
          }
        ],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "89000000-0000-0000-0000-000000000001",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0000-000000000001",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0000-000000000001"
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
          "sse"
        ],
        "sources": []
      },
      "checksum": "a29bcf0d6704bc27b49bbbd1a2f2a99dc1716696813163b381af8ca6d2dd760b"
    }
  },
  "SYSTEM:general-medicine-consultation": {
    "graphChecksum": "51a8709a194df0b29230af554f293eaf7cc63e2c1b278b79384a51d7634f3f1d",
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
      "definitionId": "99000000-0000-0000-0000-000000000002",
      "slug": "general-medicine-consultation",
      "versionNumber": 1,
      "tenantId": "00000000-0000-0000-0000-000000000000",
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
                  "contextSchemaId": "79000000-0000-0000-0002-000000000001",
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object",
                        "properties": {
                          "sttSessionId": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "transcript": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          }
                        ]
                      },
                      "work_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "case_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "attachment": {
                        "anyOf": [
                          {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                              "mediaId": {
                                "type": "string",
                                "minLength": 1
                              },
                              "mime": {
                                "type": "string",
                                "minLength": 1
                              },
                              "name": {
                                "type": "string"
                              },
                              "size": {
                                "type": "integer",
                                "minimum": 0
                              }
                            },
                            "required": [
                              "mediaId",
                              "mime"
                            ]
                          },
                          {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "additionalProperties": false,
                              "properties": {
                                "mediaId": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "mime": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "name": {
                                  "type": "string"
                                },
                                "size": {
                                  "type": "integer",
                                  "minimum": 0
                                }
                              },
                              "required": [
                                "mediaId",
                                "mime"
                              ]
                            }
                          }
                        ]
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
              "nodeId": "n_summary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "general-medicine-summarization",
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
          "stageIndex": 4,
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
                "onError": "fail",
                "timeoutSeconds": 600
              },
              "timeoutSeconds": 600,
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
                  "fromNodeId": "n_summary",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "message": {
                  "from": "nodes.n_summary.outputs.text"
                }
              }
            }
          ]
        },
        {
          "stageIndex": 5,
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
          "stageIndex": 6,
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
            "templateId": "71000000-0000-0000-0000-000000000040",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0004-000000000004",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0004-000000000003",
            "versionNumber": 1
          },
          {
            "nodeId": "n_finalize",
            "templateId": "71000000-0000-0000-0004-000000000003",
            "versionNumber": 1
          }
        ],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "89000000-0000-0000-0002-000000000001",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0002-000000000001",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0002-000000000001"
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
      "checksum": "cbbd5d0b58dd851ded6cc0696f61364ba8ebf8b8547b4aa4aa80eef4d3a996af"
    }
  },
  "SYSTEM:platform-default-summarization": {
    "graphChecksum": "f29388d429af220451d0fe69acfdee269846a7f362e1d207f388e06a6c574019",
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
      "definitionId": "99000000-0000-0000-0000-000000000001",
      "slug": "platform-default-summarization",
      "versionNumber": 1,
      "tenantId": "00000000-0000-0000-0000-000000000000",
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
                  "api"
                ],
                "contextSchema": {
                  "contextSchemaId": "79000000-0000-0000-0002-000000000001",
                  "resolved": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "audio_stream": {
                        "type": "object",
                        "properties": {
                          "sttSessionId": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "transcript": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          }
                        ]
                      },
                      "work_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "case_note": {
                        "anyOf": [
                          {
                            "type": "string"
                          },
                          {
                            "type": "object"
                          },
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "object"
                                }
                              ]
                            }
                          }
                        ]
                      },
                      "attachment": {
                        "anyOf": [
                          {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                              "mediaId": {
                                "type": "string",
                                "minLength": 1
                              },
                              "mime": {
                                "type": "string",
                                "minLength": 1
                              },
                              "name": {
                                "type": "string"
                              },
                              "size": {
                                "type": "integer",
                                "minimum": 0
                              }
                            },
                            "required": [
                              "mediaId",
                              "mime"
                            ]
                          },
                          {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "additionalProperties": false,
                              "properties": {
                                "mediaId": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "mime": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "name": {
                                  "type": "string"
                                },
                                "size": {
                                  "type": "integer",
                                  "minimum": 0
                                }
                              },
                              "required": [
                                "mediaId",
                                "mime"
                              ]
                            }
                          }
                        ]
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
              "nodeId": "n_summary",
              "type": "core.agent",
              "activity": "interpreter.core_agent",
              "config": {
                "agentRef": {
                  "slug": "general-medicine-summarization",
                  "versionNumber": 1
                },
                "execution": {
                  "lane": "durable",
                  "cadence": "once"
                },
                "onError": "fail",
                "timeoutSeconds": 600
              },
              "timeoutSeconds": 600,
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
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "context": {
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
              "nodeId": "n_output",
              "type": "core.output",
              "activity": "interpreter.core_output",
              "config": {
                "protocols": [
                  "http",
                  "http-sse"
                ],
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
                  "fromNodeId": "n_summary",
                  "fromPort": "out",
                  "toPort": "in"
                }
              ],
              "onError": "fail",
              "emitsTrajectory": true,
              "bindings": {
                "in": {
                  "from": "nodes.n_summary.outputs.text"
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
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0004-000000000004",
            "versionNumber": 1
          },
          {
            "nodeId": "n_summary",
            "templateId": "71000000-0000-0000-0004-000000000003",
            "versionNumber": 1
          }
        ],
        "documentTemplateRefs": [],
        "contextSchemaVersionId": "89000000-0000-0000-0002-000000000001",
        "entitlementKeys": [],
        "contextSchemaRefs": [
          {
            "nodeId": "n_trigger",
            "schemaId": "79000000-0000-0000-0002-000000000001",
            "versionNumber": 1,
            "versionId": "89000000-0000-0000-0002-000000000001"
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
          "sse"
        ],
        "sources": []
      },
      "checksum": "4c71df56b9397f6a6d0dcd8fd58d35928d655cc11445ce2dfe4413950bf5b9cd"
    }
  }
};

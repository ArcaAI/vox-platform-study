/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by `scripts/regen-realtime-transcription-agent-seed.ts` from the REAL
 * `validate()` / `compile()` / `registryChecksum()` in `packages/workflow-contract` and the REAL
 * `compileSttGraphToYaml` in `packages/applications`, against the graph authored in
 * `23a-realtime-transcription-agent.ts`.
 *
 * Every value here is engine output. Editing one by hand would assert a compiler verdict that
 * no compiler ever reached — and `task-858-realtime-transcription-agent.test.ts` re-runs all four
 * functions and compares, so the edit would fail CI rather than ship.
 *
 * To change any of it, change the GRAPH and re-run the script:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-realtime-transcription-agent-seed.ts
 */

export const REGISTRY_CHECKSUM: string = "c0aa308b37b27ba36ad84d54599633aa7461c1a2b770eac52dddf84d3878bbcb" as const;

export const PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM: string = "31838f6798a2cec20d4c7bf92dc038b25a17711a76fab8b5ff2b5b6cd6d0607d" as const;

export const PLATFORM_TRANSCRIPTION_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "c0aa308b37b27ba36ad84d54599633aa7461c1a2b770eac52dddf84d3878bbcb",
  "evaluatedAt": "2026-09-03T00:00:00.000Z"
} as const;

export const PLATFORM_TRANSCRIPTION_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0002-000000000001",
  "slug": "platform-realtime-transcription-medical-en",
  "versionNumber": 1,
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "paletteKey": "stt",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "c0aa308b37b27ba36ad84d54599633aa7461c1a2b770eac52dddf84d3878bbcb",
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
          "nodeId": "n_audio",
          "type": "stt.audioInput",
          "activity": "interpreter.stt_audio_input",
          "config": {
            "mode": "realtime"
          },
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
          "nodeId": "n_denoise",
          "type": "stt.noiseFilter",
          "activity": "interpreter.stt_noise_filter",
          "config": {
            "modelSlug": "deepfilternet3"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_audio",
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
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_vad",
          "type": "stt.vad",
          "activity": "interpreter.stt_vad",
          "config": {
            "modelSlug": "silero-vad"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_denoise",
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
          "nodeId": "n_lang",
          "type": "stt.languageDetection",
          "activity": "interpreter.stt_language_detection",
          "config": {
            "mode": "single",
            "languageModeId": "en"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_vad",
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
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_asr",
          "type": "stt.asrEngine",
          "activity": "interpreter.stt_asr_engine",
          "config": {
            "modelSlug": "whisper-large-en-medical-260726-merged-gguf-q8_0",
            "onError": "fail"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_lang",
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
          "nodeId": "n_out",
          "type": "stt.transcriptOutput",
          "activity": "interpreter.stt_transcript_output",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_asr",
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
              "fromNodeId": "n_out",
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
  "gates": [],
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
  "checksum": "b45d9a936f0e7fdcbc1b8a121946374b6f79fa17f73378bd793dfcfc76fc02c4"
} as const;

export const ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM: string = "31838f6798a2cec20d4c7bf92dc038b25a17711a76fab8b5ff2b5b6cd6d0607d" as const;

export const ARCAAI_TRANSCRIPTION_VALIDATION_REPORT: Record<string, unknown> = {
  "reportVersion": 1,
  "ok": true,
  "findings": [],
  "ruleSetVersion": 1,
  "registryChecksum": "c0aa308b37b27ba36ad84d54599633aa7461c1a2b770eac52dddf84d3878bbcb",
  "evaluatedAt": "2026-09-03T00:00:00.000Z"
} as const;

export const ARCAAI_TRANSCRIPTION_COMPILED_CONFIG: Record<string, unknown> = {
  "formatVersion": 1,
  "definitionId": "99000000-0000-0000-0002-000000000002",
  "slug": "arcaai-realtime-transcription-medical-en",
  "versionNumber": 1,
  "tenantId": "50000000-0000-0000-0000-000000000001",
  "paletteKey": "stt",
  "compiledAt": "2026-09-03T00:00:00.000Z",
  "compilerVersion": "0.1.0",
  "registryChecksum": "c0aa308b37b27ba36ad84d54599633aa7461c1a2b770eac52dddf84d3878bbcb",
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
          "nodeId": "n_audio",
          "type": "stt.audioInput",
          "activity": "interpreter.stt_audio_input",
          "config": {
            "mode": "realtime"
          },
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
          "nodeId": "n_denoise",
          "type": "stt.noiseFilter",
          "activity": "interpreter.stt_noise_filter",
          "config": {
            "modelSlug": "deepfilternet3"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_audio",
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
      "stageIndex": 3,
      "nodes": [
        {
          "nodeId": "n_vad",
          "type": "stt.vad",
          "activity": "interpreter.stt_vad",
          "config": {
            "modelSlug": "silero-vad"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_denoise",
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
          "nodeId": "n_lang",
          "type": "stt.languageDetection",
          "activity": "interpreter.stt_language_detection",
          "config": {
            "mode": "single",
            "languageModeId": "en"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_vad",
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
      "stageIndex": 5,
      "nodes": [
        {
          "nodeId": "n_asr",
          "type": "stt.asrEngine",
          "activity": "interpreter.stt_asr_engine",
          "config": {
            "modelSlug": "whisper-large-en-medical-260726-merged-gguf-q8_0",
            "onError": "fail"
          },
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_lang",
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
          "nodeId": "n_out",
          "type": "stt.transcriptOutput",
          "activity": "interpreter.stt_transcript_output",
          "config": {},
          "timeoutSeconds": 60,
          "retry": {
            "maximumAttempts": 1,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2
          },
          "inputs": [
            {
              "fromNodeId": "n_asr",
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
              "fromNodeId": "n_out",
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
  "gates": [],
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
  "checksum": "9b2d90659daf9c9f86ecec95c0a0a96b23af0c283a84c2ec8f4234a889079b02"
} as const;

export const PIPELINE_CONFIG_YAML: string = "version: \"2.0\"\nmodels:\n  asr: \"whisper-large-en-medical-260726-merged-gguf-q8_0\"\n  vad: \"silero-vad\"\n  denoise: \"deepfilternet3\"\ninference:\n  language: \"en\"\n" as const;

## Language

The transcription language for batch (file upload) jobs is determined by the selected pipeline configuration. Each pipeline specifies its language settings, so the client does not need to provide a language override.

<!-- @section -->

### Supported Languages

| Code | Language  |
| ---- | --------- |
| `en` | English   |
| `hi` | Hindi     |
| `ta` | Tamil     |
| `ml` | Malayalam |
| `es` | Spanish   |
| `fr` | French    |
| `de` | German    |
| `th` | Thai      |

<!-- @/section -->

<!-- @section -->

### Behavior

- The language is determined by the pipeline configuration.
- Disabled while upload/transcription is in progress.
- The client sends only the `pipelineId` — the backend resolves language from the pipeline config.

<!-- @/section -->

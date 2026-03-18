## Language

Sets the language hint used for batch (file upload) transcription. Providing a language improves accuracy for many Audio pipelines.

<!-- @section -->

### Supported Languages

| Code | Language |
|------|----------|
| `en` | English |
| `hi` | Hindi |
| `ta` | Tamil |
| `ml` | Malayalam |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `th` | Thai |

<!-- @/section -->

<!-- @section -->

### Behavior

- Defaults to English (`en`).
- Disabled while upload/transcription is in progress.
- Sent to the backend as part of the job request.
- Works with code-switching when enabled.

<!-- @/section -->

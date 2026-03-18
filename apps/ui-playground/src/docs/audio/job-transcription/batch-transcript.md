## Batch Transcript

### What This Does

Displays the transcription output for an uploaded audio file. Processing runs on the backend, and transcript segments stream back in real-time via SSE (Server-Sent Events).

<!-- @section -->

### Transcript Entry Details

Each segment can include:

- **Segment number** — Sequential identifier
- **Speaker label** — Present when diarization is enabled
- **Timestamp** — Time the segment was received
- **Text** — Transcribed speech
- **Timing** — Start, end, and duration

<!-- @example -->

```tsx
const { transcripts, status, jobId } = useFileTranscription();

const wordCount = transcripts.reduce(
  (acc, segment) => acc + segment.text.split(/\s+/).length,
  0
);
```

<!-- @/example -->
<!-- @/section -->

<!-- @section -->

### Status Display

| Status | Description |
|--------|-------------|
| `idle` | No upload started |
| `uploading` | File is being uploaded |
| `streaming` | Transcript segments are streaming |
| `complete` | Processing finished successfully |
| `error` | Upload or processing failed |

<!-- @/section -->

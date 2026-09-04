import { redirect } from 'next/navigation';

/**
 * TASK-861 — `/audio/pipelines` is RETIRED. `AsrPipeline` is deprecated (removed in
 * R4); the ASR Agent (`/agents`, task `SPEECH_TO_TEXT`) is the one authoring surface
 * for transcription. This redirect stub survives ONE release so bookmarks and deep
 * links land on the live screen; delete the folder in R3.
 */
export default function AudioPipelinesPage() {
  redirect('/agents?task=SPEECH_TO_TEXT');
}

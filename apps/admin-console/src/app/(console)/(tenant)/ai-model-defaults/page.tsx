import { permanentRedirect } from 'next/navigation';

/**
 * The screen formerly here was renamed `/ai-configuration` once it stopped
 * being about "model defaults" (every model picker had already been
 * write-locked to read-only). TASK-932 retired `/ai-configuration` too, so this
 * stub points straight at the surviving target rather than hopping through a
 * second redirect. It keeps bookmarks and deep links alive for one release
 * (deleted together with `/ai-configuration` in R4), then it is deleted.
 */
export default function AiModelDefaultsRedirectPage() {
  permanentRedirect('/agents?task=SPEECH_TO_TEXT');
}

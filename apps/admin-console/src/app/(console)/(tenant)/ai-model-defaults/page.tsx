import { permanentRedirect } from 'next/navigation';

/**
 * TASK-526 (M-04 tenant leg) — the screen formerly here was renamed
 * `/ai-configuration` once it stopped being about "model defaults" (the E3
 * write-lock had already removed every picker; see M-05). This redirect keeps
 * bookmarks and deep links alive for one release, then it is deleted.
 */
export default function AiModelDefaultsRedirectPage() {
  permanentRedirect('/ai-configuration');
}

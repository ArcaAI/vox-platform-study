import { redirect } from 'next/navigation';

/**
 * `/pstudio` moved to `/db-studio`.
 *
 * Kept for ONE release so existing bookmarks and deep links keep working; the
 * nav entry already points at the new route. Delete this folder in the release
 * after the one that ships the rename.
 */
export default function PstudioRedirectPage(): never {
  redirect('/db-studio');
}

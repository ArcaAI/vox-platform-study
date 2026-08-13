'use client';

import { useRef, useState } from 'react';
import { Markdown } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { useRouter } from 'next/navigation';
import { useSession } from '@/shared/auth';
import { cx } from '@/shared/cx';
import { useAcknowledgeChangelog, useUnseenChangelog } from '../api/hooks';
import type { ChangelogEntry } from '../api/types';
import { ChangelogSeverityBadge } from './severity-badge';

const MAX_SHOWN = 3;
/** Session-scoped guard so a hard reload / remount within the same tab does not re-open it. */
const SHOWN_SESSION_KEY = 'hope-whats-new-shown';

function readAlreadyShown(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(SHOWN_SESSION_KEY) === '1';
}

type PopupState = { status: 'idle' | 'shown' } | { status: 'open'; entries: ChangelogEntry[] };

/**
 * One-time "What's New" popup. Mounted once in `(console)/layout.tsx`
 * so it fires on the first console load after login, not on every navigation —
 * the layout persists across client-side route changes, and the session-storage
 * guard covers a full reload within the same tab.
 *
 * Never renders while impersonating: the server already excludes
 * entries from `/changelog/unseen` in that case, but this is defense-in-depth —
 * a support session must never silently acknowledge a notice on behalf of the
 * real user.
 */
export function WhatsNewDialog() {
  const router = useRouter();
  const { data: session } = useSession();
  const isImpersonating = Boolean(session?.impersonatingUserId);

  // Lazy initializer (not a render-time ref read) — evaluated once on mount.
  const [popup, setPopup] = useState<PopupState>(() => ({ status: readAlreadyShown() ? 'shown' : 'idle' }));
  /**
   * Radix restores focus to a `DialogTrigger` ref, which this popup has none
   * of (it opens itself, not from a click) — so capture whatever was focused
   * when this component first mounted (before the query resolves or the
   * Dialog itself ever commits as open, so Radix's own auto-focus can never
   * race it) and restore it on dismiss, satisfying the same "focus returns
   * on close" contract as a triggered dialog (rule 11 §Dialogs; WCAG 2.4.3).
   * `useRef`'s initial-value argument runs once per mount; it is a DOM read,
   * not a `.current` access, so it is render-safe.
   */
  const previouslyFocusedRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));

  const enabled = Boolean(session) && !isImpersonating && popup.status === 'idle';
  const { data: unseen } = useUnseenChangelog(enabled);
  const acknowledge = useAcknowledgeChangelog();

  // Render-time derived-state transition (no effect — mirrors the hydration
  // pattern used elsewhere in this app): the query settles at most once while
  // `popup.status === 'idle'`, so this fires exactly once per mount, not on
  // every render. Capturing focus here (before the Dialog itself ever
  // commits as open) is what lets `dismiss()` restore it correctly.
  if (!isImpersonating && popup.status === 'idle' && unseen) {
    if (unseen.length === 0) {
      setPopup({ status: 'shown' });
    } else {
      const entries = [...unseen]
        .sort((a, b) => (a.publishedAt && b.publishedAt ? new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() : 0))
        .slice(0, MAX_SHOWN);
      if (typeof window !== 'undefined') window.sessionStorage.setItem(SHOWN_SESSION_KEY, '1');
      setPopup({ status: 'open', entries });
    }
  }

  const shownEntries = popup.status === 'open' ? popup.entries : [];

  function dismiss() {
    setPopup({ status: 'shown' });
    if (shownEntries.length > 0) {
      acknowledge.mutate(shownEntries.map((entry) => entry.id));
    }
    // Runs after Radix's own unmount-focus handling (which has no
    // DialogTrigger to restore to here) so our restore target wins.
    const target = previouslyFocusedRef.current;
    if (target && typeof window !== 'undefined') {
      window.setTimeout(() => target.focus(), 0);
    }
  }

  // Never render while impersonating, and never render with nothing to show —
  // no wrapper, no flash (per the brief).
  if (isImpersonating || popup.status !== 'open' || shownEntries.length === 0) {
    return null;
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="flex h-[70vh] w-full flex-col gap-0 sm:max-w-[70vw]">
        <DialogHeader className="shrink-0 gap-1.5 border-b pb-4">
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription>{shownEntries.length} recent release {shownEntries.length === 1 ? 'note' : 'notes'}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <div className="flex flex-col gap-6">
            {shownEntries.map((entry) => (
              <article key={entry.id} className="flex flex-col gap-2 border-b pb-6 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold tracking-tight">{entry.title}</h3>
                  <ChangelogSeverityBadge severity={entry.severity} />
                  <span className="text-muted-foreground font-mono text-xs">{entry.platformVersion}</span>
                </div>
                <p className="text-muted-foreground text-sm">{entry.summary}</p>
                {/* Markdown from @arcaai/ui uses react-markdown without rehype-raw:
                    raw HTML/script in `body` is never parsed as markup — XSS-safe. */}
                <div className={cx('text-sm leading-relaxed')}>
                  <Markdown>{entry.body}</Markdown>
                </div>
              </article>
            ))}
          </div>
        </div>
        <DialogFooter className="shrink-0 gap-2 border-t pt-4 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              dismiss();
              router.push('/changelog');
            }}
          >
            See all changes
          </Button>
          <Button type="button" onClick={dismiss}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

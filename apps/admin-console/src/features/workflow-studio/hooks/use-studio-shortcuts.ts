'use client';

/**
 * Keyboard shortcuts for the graph editor ( UX pass) — undo / redo / duplicate.
 *
 * Deliberately narrow: only chords that are already muscle memory in every editor, and only
 * while the focus is NOT inside a text field. The inspector renders real inputs and a
 * `CodeEditor`; a bare `Ctrl+Z` there must keep meaning "undo my typing", so a shortcut that
 * stole it would be a regression, not a feature. Node delete is NOT bound here — React Flow
 * already owns Delete/Backspace on a focused canvas node, so a third binding would only add a
 * way to lose work by accident.
 *
 * Every shortcut has a visible, clickable equivalent in `StudioToolbar`, so nothing here is the
 * ONLY path to an action (WCAG 2.1.1 / 2.5.7). TASK-893 §3.4 deleted the List view, which used
 * to be the documented pointer-free path; the keyboard equivalents now live on the canvas and in
 * the toolbar, and the studio shell owns proving that every mutation still has a non-drag path.
 */
import { useEffect } from 'react';

export interface StudioShortcutHandlers {
  enabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useStudioShortcuts({ enabled, onUndo, onRedo, onDuplicate }: StudioShortcutHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    function handler(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isTextEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) onRedo();
        else onUndo();
        return;
      }
      // Ctrl+Y is the Windows redo chord; Cmd+Y is a browser history shortcut on macOS, so it
      // is bound for the ctrl form only.
      if (key === 'y' && !event.shiftKey && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        onRedo();
        return;
      }
      if (key === 'd' && !event.shiftKey) {
        event.preventDefault();
        onDuplicate();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onUndo, onRedo, onDuplicate]);
}

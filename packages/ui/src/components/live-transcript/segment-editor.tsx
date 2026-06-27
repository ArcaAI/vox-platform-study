'use client';

import * as React from 'react';
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { Check, X } from 'lucide-react';

import { Button } from '@/components/shadcn/button';

export interface SegmentEditorProps {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  saving?: boolean;
}

/** Bridges the Lexical editor instance up so `Save` can serialize → plain text. */
function EditorBridge({ onReady }: { onReady: (getText: () => string) => void }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => {
    onReady(() => editor.getEditorState().read(() => $getRoot().getTextContent()));
  }, [editor, onReady]);
  return null;
}

/**
 * Inline transcript segment editor (D4 — Lexical). Lazy-mounted only for the row
 * under edit. `Save` serializes the editor to plain text; Esc cancels,
 * ⌘/Ctrl+Enter saves.
 */
export default function SegmentEditor({ initialText, onSave, onCancel, saving }: SegmentEditorProps) {
  const getTextRef = React.useRef<() => string>(() => initialText);

  const initialConfig: InitialConfigType = {
    namespace: 'TranscriptSegmentEditor',
    onError: (error: Error) => console.error(error),
    editorState: () => {
      const root = $getRoot();
      if (root.getFirstChild() === null) {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(initialText));
        root.append(paragraph);
      }
    },
  };

  const save = React.useCallback(() => onSave(getTextRef.current()), [onSave]);

  return (
    <div
      data-slot="segment-editor"
      className="rounded-md border bg-background p-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <LexicalComposer initialConfig={initialConfig}>
        <EditorBridge onReady={(getText) => (getTextRef.current = getText)} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Edit transcript segment"
              className="min-h-9 w-full rounded-sm px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <AutoFocusPlugin />
      </LexicalComposer>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel edit">
          <X className="size-4" />
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={saving} aria-label="Save edit">
          <Check className="size-4" />
          Save
        </Button>
      </div>
    </div>
  );
}

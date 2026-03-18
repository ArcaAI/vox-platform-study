import type { AssembledGenerateRequest } from '../api';

export interface ContextItemInputLike {
  type?: string;
  content?: string;
}

interface buildAssembledPayloadParams {
  inputMode: 'context_item' | 'message';
  selectedContextItemIds: string[];
  contextText: string;
  selectedContextItems?: ContextItemInputLike[];
  includeMessageForContextItems?: boolean;
}

const TYPE_LABEL_MAP: Record<string, string> = {
  TRANSCRIPT: 'Transcript',
  CASE_NOTE: 'Case Note',
  WORKNOTE: 'Work Note',
  RAW_SUMMARY: 'Summary',
  MODIFIED_SUMMARY: 'Edited Summary',
  PRE_SUMMARY: 'Pre-Summary',
  // AUDIO_RECORDING: 'Audio',
  // ATTACHMENT: 'Attachment',
};

function buildContextItemMessage(selectedContextItems: ContextItemInputLike[]): string {
  return selectedContextItems
    .map((item) => {
      const content = item.content?.trim() ?? '';
      if (!content) return '';
      const label = TYPE_LABEL_MAP[item.type ?? ''] ?? 'Context';
      return `${label}:\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildAssembledPayload({
  inputMode,
  selectedContextItemIds,
  contextText,
  selectedContextItems = [],
  includeMessageForContextItems = false,
}: buildAssembledPayloadParams): Pick<AssembledGenerateRequest, 'context_item_ids' | 'message'> {
  if (inputMode === 'context_item' && selectedContextItemIds.length > 0) {
    if (includeMessageForContextItems) {
      const message = buildContextItemMessage(selectedContextItems);
      return message ? { message } : {};
    }
    return { context_item_ids: selectedContextItemIds };
  }

  if (inputMode === 'message' && contextText.trim()) {
    return { message: contextText };
  }

  return {};
}

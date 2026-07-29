import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ConversationEmptyState, messagesToMarkdown } from '../../../registries/ai-elements/conversation';

describe('ConversationEmptyState', () => {
  it('renders without crashing', () => {
    const { container } = render(<ConversationEmptyState />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders custom title and description', () => {
    const { getByText } = render(<ConversationEmptyState title="Welcome" description="Start chatting" />);
    expect(getByText('Welcome')).toBeTruthy();
    expect(getByText('Start chatting')).toBeTruthy();
  });
});

describe('messagesToMarkdown', () => {
  it('converts messages to markdown', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ];
    const md = messagesToMarkdown(messages);
    expect(md).toContain('**User:** Hello');
    expect(md).toContain('**Assistant:** Hi there!');
  });
});

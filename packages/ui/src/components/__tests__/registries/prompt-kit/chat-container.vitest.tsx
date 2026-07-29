import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor } from '../../../registries/prompt-kit/chat-container';

describe('ChatContainer', () => {
  it('renders without crashing', () => {
    render(
      <ChatContainerRoot>
        <ChatContainerContent>Hello</ChatContainerContent>
      </ChatContainerRoot>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders with scroll anchor', () => {
    render(
      <ChatContainerRoot>
        <ChatContainerContent>Content</ChatContainerContent>
        <ChatContainerScrollAnchor />
      </ChatContainerRoot>,
    );
    expect(screen.getByText('Content')).toBeInTheDocument();
  });
});

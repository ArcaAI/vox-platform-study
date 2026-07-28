import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Message, MessageContent, MessageActions, MessageAction } from '../../../registries/ai-elements/message';

describe('Message', () => {
  it('renders user message without crashing', () => {
    const { container } = render(
      <Message from="user">
        <MessageContent>Hello</MessageContent>
      </Message>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders assistant message without crashing', () => {
    const { container } = render(
      <Message from="assistant">
        <MessageContent>Hi there!</MessageContent>
      </Message>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('applies user class for user messages', () => {
    const { container } = render(
      <Message from="user">
        <MessageContent>Test</MessageContent>
      </Message>,
    );
    expect(container.firstElementChild?.className).toContain('is-user');
  });

  it('renders message actions', () => {
    const { container } = render(
      <MessageActions>
        <MessageAction tooltip="Copy">Copy</MessageAction>
      </MessageActions>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

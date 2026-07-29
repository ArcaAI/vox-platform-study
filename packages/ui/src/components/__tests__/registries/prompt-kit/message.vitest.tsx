import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Message, MessageContent } from '../../../registries/prompt-kit/message';

describe('Message', () => {
  it('renders without crashing', () => {
    render(
      <Message>
        <MessageContent>Hello there</MessageContent>
      </Message>,
    );
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });
});

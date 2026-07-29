import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PromptInput, PromptInputTextarea } from '../../../registries/prompt-kit/prompt-input';

describe('PromptInput', () => {
  it('renders without crashing', () => {
    render(
      <PromptInput>
        <PromptInputTextarea placeholder="Type here..." />
      </PromptInput>,
    );
    expect(screen.getByPlaceholderText('Type here...')).toBeInTheDocument();
  });
});

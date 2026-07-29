import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PromptInput, PromptInputTextarea, PromptInputFooter, PromptInputSubmit } from '../../../registries/ai-elements/prompt-input';

describe('PromptInput', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputTextarea />
        <PromptInputFooter>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>,
    );
    expect(container.querySelector('form')).toBeTruthy();
  });

  it('renders a textarea', () => {
    const { container } = render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    expect(container.querySelector('textarea')).toBeTruthy();
  });
});

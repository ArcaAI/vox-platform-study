import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../registries/prompt-kit/reasoning';

describe('Reasoning', () => {
  it('renders without crashing', () => {
    render(
      <Reasoning>
        <ReasoningTrigger>Show reasoning</ReasoningTrigger>
        <ReasoningContent>The reasoning content</ReasoningContent>
      </Reasoning>,
    );
    expect(screen.getByText('Show reasoning')).toBeInTheDocument();
  });
});

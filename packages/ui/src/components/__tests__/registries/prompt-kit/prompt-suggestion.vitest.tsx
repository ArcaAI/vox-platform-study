import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PromptSuggestion } from '../../../registries/prompt-kit/prompt-suggestion';

describe('PromptSuggestion', () => {
  it('renders without crashing', () => {
    render(<PromptSuggestion>Tell me a joke</PromptSuggestion>);
    expect(screen.getByText('Tell me a joke')).toBeInTheDocument();
  });
});

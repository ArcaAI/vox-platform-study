import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from '../../../registries/prompt-kit/markdown';

describe('Markdown', () => {
  it('renders without crashing', () => {
    render(<Markdown>{'# Hello World'}</Markdown>);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });
});

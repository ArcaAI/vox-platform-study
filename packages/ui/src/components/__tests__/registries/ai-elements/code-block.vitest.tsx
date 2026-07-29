import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CodeBlock } from '../../../registries/ai-elements/code-block';

describe('CodeBlock', () => {
  it('renders without crashing', () => {
    const { container } = render(<CodeBlock code="console.log('hello')" language="javascript" />);
    expect(container.firstChild).toBeTruthy();
  });
});

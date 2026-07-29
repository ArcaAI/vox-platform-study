import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ResponseStream } from '../../../registries/prompt-kit/response-stream';

describe('ResponseStream', () => {
  it('renders without crashing', () => {
    const { container } = render(<ResponseStream textStream="Hello streaming world" />);
    expect(container.firstChild).toBeTruthy();
  });
});

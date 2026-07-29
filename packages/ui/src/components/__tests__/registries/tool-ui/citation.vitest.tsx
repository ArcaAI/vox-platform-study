import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Citation } from '../../../registries/tool-ui/citation';

describe('Citation', () => {
  it('renders without crashing', () => {
    render(<Citation id="1" href="https://example.com" title="Example" />);
    expect(screen.getByText('Example')).toBeInTheDocument();
  });
});

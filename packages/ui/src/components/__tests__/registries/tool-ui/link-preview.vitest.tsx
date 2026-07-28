import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkPreview } from '../../../registries/tool-ui/link-preview';

describe('LinkPreview', () => {
  it('renders without crashing', () => {
    render(<LinkPreview id="1" href="https://example.com" title="Example" />);
    expect(screen.getByText('Example')).toBeInTheDocument();
  });
});

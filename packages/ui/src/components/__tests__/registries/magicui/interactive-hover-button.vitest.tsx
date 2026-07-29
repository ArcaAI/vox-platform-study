import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InteractiveHoverButton } from '../../../registries/magicui/interactive-hover-button';

describe('InteractiveHoverButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<InteractiveHoverButton>Test</InteractiveHoverButton>);
    expect(container.firstChild).toBeTruthy();
  });
});

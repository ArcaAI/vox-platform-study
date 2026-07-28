import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ShineBorder } from '../../../registries/magicui/shine-border';

describe('ShineBorder', () => {
  it('renders without crashing', () => {
    const { container } = render(<ShineBorder>Test</ShineBorder>);
    expect(container.firstChild).toBeTruthy();
  });
});

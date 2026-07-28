import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TextAnimate } from '../../../registries/magicui/text-animate';

describe('TextAnimate', () => {
  it('renders without crashing', () => {
    const { container } = render(<TextAnimate>Test</TextAnimate>);
    expect(container.firstChild).toBeTruthy();
  });
});

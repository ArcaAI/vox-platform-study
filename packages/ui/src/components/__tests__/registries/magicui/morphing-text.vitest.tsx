import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MorphingText } from '../../../registries/magicui/morphing-text';

describe('MorphingText', () => {
  it('renders without crashing', () => {
    const { container } = render(<MorphingText texts={['Hello', 'World']} />);
    expect(container.firstChild).toBeTruthy();
  });
});

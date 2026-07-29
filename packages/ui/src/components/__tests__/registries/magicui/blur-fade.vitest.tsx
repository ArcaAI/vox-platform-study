import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BlurFade } from '../../../registries/magicui/blur-fade';

describe('BlurFade', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <BlurFade>
        <div>Content</div>
      </BlurFade>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

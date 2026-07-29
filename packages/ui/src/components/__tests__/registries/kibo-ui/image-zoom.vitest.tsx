import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ImageZoom } from '../../../registries/kibo-ui/image-zoom';

describe('ImageZoom', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ImageZoom>
        <img src="https://placehold.co/100x100" alt="test" />
      </ImageZoom>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

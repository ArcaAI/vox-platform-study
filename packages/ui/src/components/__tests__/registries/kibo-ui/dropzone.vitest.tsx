import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Dropzone, DropzoneContent, DropzoneEmptyState } from '../../../registries/kibo-ui/dropzone';

describe('Dropzone', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Dropzone>
        <DropzoneContent />
        <DropzoneEmptyState />
      </Dropzone>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

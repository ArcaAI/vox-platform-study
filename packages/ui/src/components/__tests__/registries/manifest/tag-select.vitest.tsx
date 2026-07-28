import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TagSelect } from '../../../registries/manifest/tag-select';

describe('TagSelect', () => {
  it('renders without crashing', () => {
    const { container } = render(<TagSelect />);
    expect(container.firstChild).toBeTruthy();
  });
});

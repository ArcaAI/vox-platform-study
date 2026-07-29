import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PostCard } from '../../../registries/manifest/post-card';

describe('PostCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<PostCard />);
    expect(container.firstChild).toBeTruthy();
  });
});

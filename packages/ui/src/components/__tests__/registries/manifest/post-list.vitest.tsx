import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PostList } from '../../../registries/manifest/post-list';

describe('PostList', () => {
  it('renders without crashing', () => {
    const { container } = render(<PostList />);
    expect(container.firstChild).toBeTruthy();
  });
});

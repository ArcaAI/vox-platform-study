import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PostDetail } from '../../../registries/manifest/post-detail';

describe('PostDetail', () => {
  it('renders without crashing', () => {
    const { container } = render(<PostDetail />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders in inline mode', () => {
    const { container } = render(<PostDetail appearance={{ displayMode: 'inline' }} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders in pip mode', () => {
    const { container } = render(<PostDetail appearance={{ displayMode: 'pip' }} />);
    expect(container.firstChild).toBeTruthy();
  });
});

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AvatarCircles } from '../../../registries/magicui/avatar-circles';

describe('AvatarCircles', () => {
  it('renders without crashing', () => {
    const { container } = render(<AvatarCircles avatarUrls={[{ imageUrl: 'https://example.com/img.jpg', profileUrl: '#' }]} />);
    expect(container.firstChild).toBeTruthy();
  });
});

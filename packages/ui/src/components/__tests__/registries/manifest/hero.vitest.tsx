import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Hero } from '../../../registries/manifest/hero';

describe('Hero', () => {
  it('renders without crashing', () => {
    const { container } = render(<Hero />);
    expect(container.firstChild).toBeTruthy();
  });
});

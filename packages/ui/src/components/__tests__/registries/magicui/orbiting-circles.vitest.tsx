import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { OrbitingCircles } from '../../../registries/magicui/orbiting-circles';

describe('OrbitingCircles', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <OrbitingCircles>
        <div>Orbit</div>
      </OrbitingCircles>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

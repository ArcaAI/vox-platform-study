import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CodeComparison } from '../../../registries/magicui/code-comparison';

describe('CodeComparison', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CodeComparison
        beforeCode="const a = 1;"
        afterCode="const a = 2;"
        language="typescript"
        filename="example.ts"
        lightTheme="github-light"
        darkTheme="github-dark"
      />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

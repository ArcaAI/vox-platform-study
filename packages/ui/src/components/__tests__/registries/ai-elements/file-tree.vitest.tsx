import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FileTree, FileTreeFolder, FileTreeFile } from '../../../registries/ai-elements/file-tree';

describe('FileTree', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <FileTree>
        <FileTreeFile path="index.ts" name="index.ts" />
      </FileTree>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders files and folders', () => {
    const { getByText } = render(
      <FileTree defaultExpanded={new Set(['src'])}>
        <FileTreeFolder path="src" name="src">
          <FileTreeFile path="src/app.tsx" name="app.tsx" />
        </FileTreeFolder>
        <FileTreeFile path="package.json" name="package.json" />
      </FileTree>,
    );
    expect(getByText('src')).toBeTruthy();
    expect(getByText('app.tsx')).toBeTruthy();
    expect(getByText('package.json')).toBeTruthy();
  });
});

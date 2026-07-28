import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TreeProvider, TreeView, TreeNode, TreeNodeTrigger, TreeLabel } from '../../../registries/kibo-ui/tree';

describe('Tree', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <TreeProvider>
        <TreeView>
          <TreeNode nodeId="root">
            <TreeNodeTrigger>
              <TreeLabel>Root</TreeLabel>
            </TreeNodeTrigger>
          </TreeNode>
        </TreeView>
      </TreeProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  TreeProvider,
  TreeView,
  TreeNode,
  TreeNodeTrigger,
  TreeNodeContent,
  TreeExpander,
  TreeIcon,
  TreeLabel,
} from '../../../registries/kibo-ui/tree';

const meta = {
  title: 'Registries/KiboUI/Tree',
  component: TreeProvider,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TreeProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <TreeProvider defaultExpandedIds={['src']} className="w-64">
      <TreeView>
        <TreeNode nodeId="src">
          <TreeNodeTrigger>
            <TreeExpander hasChildren />
            <TreeIcon hasChildren />
            <TreeLabel>src</TreeLabel>
          </TreeNodeTrigger>
          <TreeNodeContent hasChildren>
            <TreeNode nodeId="index" level={1}>
              <TreeNodeTrigger>
                <TreeExpander />
                <TreeIcon />
                <TreeLabel>index.tsx</TreeLabel>
              </TreeNodeTrigger>
            </TreeNode>
            <TreeNode nodeId="app" level={1} isLast>
              <TreeNodeTrigger>
                <TreeExpander />
                <TreeIcon />
                <TreeLabel>app.tsx</TreeLabel>
              </TreeNodeTrigger>
            </TreeNode>
          </TreeNodeContent>
        </TreeNode>
      </TreeView>
    </TreeProvider>
  ),
};

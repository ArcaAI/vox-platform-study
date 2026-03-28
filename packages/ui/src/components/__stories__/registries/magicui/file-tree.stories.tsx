import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tree, Folder, File, type TreeViewElement } from '../../../registries/magicui/file-tree';

const meta = {
  title: 'Registries/MagicUI/FileTree',
  component: Tree,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tree>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleElements: TreeViewElement[] = [
  {
    id: '1',
    name: 'src',
    children: [
      {
        id: '1-1',
        name: 'components',
        children: [
          { id: '1-1-1', name: 'Button.tsx' },
          { id: '1-1-2', name: 'Input.tsx' },
        ],
      },
      { id: '1-2', name: 'utils.ts' },
    ],
  },
  {
    id: '2',
    name: 'package.json',
  },
];

export const Default: Story = {
  render: () => (
    <div className="h-64 w-64 rounded-md border p-4">
      <Tree elements={sampleElements} initialExpandedItems={['1', '1-1']}>
        <Folder element="src" value="1">
          <Folder element="components" value="1-1">
            <File value="1-1-1">Button.tsx</File>
            <File value="1-1-2">Input.tsx</File>
          </Folder>
          <File value="1-2">utils.ts</File>
        </Folder>
        <File value="2">package.json</File>
      </Tree>
    </div>
  ),
};

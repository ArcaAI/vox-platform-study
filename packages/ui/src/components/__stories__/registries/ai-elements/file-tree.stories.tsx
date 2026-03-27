import type { Meta, StoryObj } from '@storybook/react-vite';

import { FileTree, FileTreeFolder, FileTreeFile } from '../../../registries/ai-elements/file-tree';

const meta = {
  title: 'Registries/AiElements/FileTree',
  component: FileTree,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof FileTree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <FileTree defaultExpanded={new Set(['src'])} className="w-[300px]">
      <FileTreeFolder path="src" name="src">
        <FileTreeFolder path="src/components" name="components">
          <FileTreeFile path="src/components/Button.tsx" name="Button.tsx" />
          <FileTreeFile path="src/components/Card.tsx" name="Card.tsx" />
        </FileTreeFolder>
        <FileTreeFile path="src/index.ts" name="index.ts" />
        <FileTreeFile path="src/utils.ts" name="utils.ts" />
      </FileTreeFolder>
      <FileTreeFile path="package.json" name="package.json" />
      <FileTreeFile path="tsconfig.json" name="tsconfig.json" />
    </FileTree>
  ),
};

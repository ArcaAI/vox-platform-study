import type { Meta, StoryObj } from '@storybook/react-vite';
import { LexicalComposer } from '@lexical/react/LexicalComposer';

import { Plugins } from '../../../registries/shadcn-editor/plugins';
import { nodes } from '../../../registries/shadcn-editor/nodes';
import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme';

const editorConfig = {
  namespace: 'PluginsStory',
  theme: editorTheme,
  nodes,
  onError: (error: Error) => console.error(error),
};

const meta = {
  title: 'Registries/ShadcnEditor/Plugins',
  component: Plugins,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <LexicalComposer initialConfig={editorConfig}>
        <div className="overflow-hidden rounded-lg border" style={{ width: 500 }}>
          <Story />
        </div>
      </LexicalComposer>
    ),
  ],
} satisfies Meta<typeof Plugins>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

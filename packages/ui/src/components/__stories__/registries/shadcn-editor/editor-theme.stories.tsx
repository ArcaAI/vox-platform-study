import type { Meta, StoryObj } from '@storybook/react-vite';

import { editorTheme } from '../../../registries/shadcn-editor/themes/editor-theme';

const EditorThemeDisplay = () => (
  <div className="space-y-4 p-4 max-w-lg">
    <h3 className="text-lg font-semibold">Editor Theme Classes</h3>
    <pre className="bg-muted rounded-md p-4 text-xs overflow-auto max-h-96">{JSON.stringify(editorTheme, null, 2)}</pre>
  </div>
);

const meta = {
  title: 'Registries/ShadcnEditor/EditorTheme',
  component: EditorThemeDisplay,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof EditorThemeDisplay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

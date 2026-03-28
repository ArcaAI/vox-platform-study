import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodeBlock } from '../../../registries/tool-ui/code-block';

const meta = {
  title: 'Registries/ToolUI/CodeBlock',
  component: CodeBlock,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => <CodeBlock id="1" code='console.log("hello")' language="typescript" lineNumbers="hidden" />,
};

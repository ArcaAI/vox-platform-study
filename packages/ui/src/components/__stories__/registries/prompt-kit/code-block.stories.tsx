import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodeBlock, CodeBlockCode } from '../../../registries/prompt-kit/code-block';

const meta = {
  title: 'Registries/PromptKit/CodeBlock',
  component: CodeBlock,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <CodeBlock>
      <CodeBlockCode code="const greeting = 'Hello, World!'\nconsole.log(greeting)" />
    </CodeBlock>
  ),
};

export const WithLanguage: Story = {
  render: () => (
    <CodeBlock>
      <CodeBlockCode code="def hello():\n    print('Hello from Python!')" language="python" />
    </CodeBlock>
  ),
};

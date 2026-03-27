import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockBody,
  CodeBlockItem,
  CodeBlockContent,
  CodeBlockCopyButton,
} from '../../../registries/kibo-ui/code-block';

const sampleData = [
  {
    language: 'typescript',
    filename: 'example.ts',
    code: 'const greeting: string = "Hello, World!";\nconsole.log(greeting);',
  },
];

const meta = {
  title: 'Registries/KiboUI/CodeBlock',
  component: CodeBlock,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <CodeBlock data={sampleData} defaultValue="typescript" className="w-[500px]">
      <CodeBlockHeader>
        <CodeBlockCopyButton />
      </CodeBlockHeader>
      <CodeBlockBody>
        {(item) => (
          <CodeBlockItem key={item.language} value={item.language}>
            <CodeBlockContent language="typescript">{item.code}</CodeBlockContent>
          </CodeBlockItem>
        )}
      </CodeBlockBody>
    </CodeBlock>
  ),
};

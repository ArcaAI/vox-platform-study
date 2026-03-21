import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from '../../../registries/ai-elements/code-block'

const meta = {
  title: 'Registries/AiElements/CodeBlock',
  component: CodeBlock,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CodeBlock>

export default meta
type Story = StoryObj<typeof meta>

const sampleCode = `function greet(name: string) {
  console.log(\`Hello, \${name}!\`);
}

greet("World");`

export const Default: Story = {
  args: {
    code: sampleCode,
    language: 'typescript',
  },
}

export const WithHeader: Story = {
  args: {} as any,
  render: () => (
    <CodeBlock code={sampleCode} language="typescript" className="w-[500px]">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>example.ts</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  ),
}

export const WithLineNumbers: Story = {
  args: {
    code: sampleCode,
    language: 'typescript',
    showLineNumbers: true,
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite'

import { CodeExample } from '../../custom/code-example'

const meta = {
  title: 'Custom/CodeExample',
  component: CodeExample,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    defaultOpen: {
      control: 'boolean',
      description: 'Whether the code block is expanded by default',
    },
    language: {
      control: 'select',
      options: ['typescript', 'javascript', 'python', 'bash', 'json'],
      description: 'Programming language for syntax display',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeExample>

export default meta
type Story = StoryObj<typeof meta>

const tsCode = `import { useConversation } from '@arcaai/hooks'

const { start, stop, status } = useConversation({
  agentId: 'agent-abc-123',
  onMessage: (msg) => console.log(msg),
})

await start()`

const pythonCode = `from arcaai import HopeClient

client = HopeClient(api_key="sk-...")
result = client.analyze(
    text="Patient presents with...",
    model="gpt-4o",
)
print(result.summary)`

const jsonCode = `{
  "model": "gpt-4o",
  "temperature": 0.7,
  "max_tokens": 2048,
  "messages": [
    { "role": "system", "content": "You are a medical assistant." },
    { "role": "user", "content": "Summarize the consultation." }
  ]
}`

export const Default: Story = {
  args: {
    title: 'useConversation Hook',
    code: tsCode,
    language: 'typescript',
  },
}

export const DefaultOpen: Story = {
  args: {
    title: 'useConversation Hook',
    code: tsCode,
    language: 'typescript',
    defaultOpen: true,
  },
}

export const Python: Story = {
  args: {
    title: 'Python SDK Usage',
    code: pythonCode,
    language: 'python',
    defaultOpen: true,
  },
}

export const Json: Story = {
  args: {
    title: 'API Request Body',
    code: jsonCode,
    language: 'json',
    defaultOpen: true,
  },
}

export const LongCode: Story = {
  args: {
    title: 'Full Pipeline Setup',
    code: Array.from({ length: 30 }, (_, i) => `const step${i + 1} = await pipeline.run(${i + 1})`).join('\n'),
    language: 'typescript',
    defaultOpen: true,
  },
}

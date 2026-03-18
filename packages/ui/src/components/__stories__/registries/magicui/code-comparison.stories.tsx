import type { Meta, StoryObj } from '@storybook/react-vite'

import { CodeComparison } from '../../../registries/magicui/code-comparison'

const meta = {
  title: 'Registries/MagicUI/CodeComparison',
  component: CodeComparison,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CodeComparison>

export default meta
type Story = StoryObj<typeof meta>

const beforeCode = `function greet(name) {
  return "Hello, " + name;
}`

const afterCode = `function greet(name) {
  return \`Hello, \${name}\`;
}`

export const Default: Story = {
  args: {
    beforeCode,
    afterCode,
    language: 'javascript',
    filename: 'greet.js',
    lightTheme: 'github-light',
    darkTheme: 'github-dark',
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Snippet, SnippetInput, SnippetCopyButton, SnippetText, SnippetAddon } from '../../../registries/ai-elements/snippet';

const meta = {
  title: 'Registries/AiElements/Snippet',
  component: Snippet,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Snippet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Snippet code="npm install @arcaai/ui" className="w-[400px]">
      <SnippetInput />
      <SnippetCopyButton />
    </Snippet>
  ),
};

export const WithPrefix: Story = {
  args: {} as any,
  render: () => (
    <Snippet code="pnpm add react@latest" className="w-[400px]">
      <SnippetAddon align="inline-start">
        <SnippetText>$</SnippetText>
      </SnippetAddon>
      <SnippetInput />
      <SnippetCopyButton />
    </Snippet>
  ),
};

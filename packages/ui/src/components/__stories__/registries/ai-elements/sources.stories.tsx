import type { Meta, StoryObj } from '@storybook/react-vite';

import { Sources, SourcesTrigger, SourcesContent, Source } from '../../../registries/ai-elements/sources';

const meta = {
  title: 'Registries/AiElements/Sources',
  component: Sources,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Sources>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[400px]">
      <Sources defaultOpen>
        <SourcesTrigger count={3} />
        <SourcesContent>
          <Source href="https://react.dev" title="React Documentation" />
          <Source href="https://nextjs.org" title="Next.js Documentation" />
          <Source href="https://tailwindcss.com" title="Tailwind CSS" />
        </SourcesContent>
      </Sources>
    </div>
  ),
};

export const Collapsed: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[400px]">
      <Sources>
        <SourcesTrigger count={5} />
        <SourcesContent>
          <Source href="#" title="Source 1" />
          <Source href="#" title="Source 2" />
        </SourcesContent>
      </Sources>
    </div>
  ),
};

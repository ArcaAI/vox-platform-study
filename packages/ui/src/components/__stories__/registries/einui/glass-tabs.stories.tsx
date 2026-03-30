import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlassTabs, GlassTabsList, GlassTabsTrigger, GlassTabsContent } from '@/components/registries/einui/glass-tabs';

function GlassTabsDemo() {
  return (
    <GlassTabs defaultValue="tab1">
      <GlassTabsList>
        <GlassTabsTrigger value="tab1">Tab 1</GlassTabsTrigger>
        <GlassTabsTrigger value="tab2">Tab 2</GlassTabsTrigger>
      </GlassTabsList>
      <GlassTabsContent value="tab1">Content for Tab 1</GlassTabsContent>
      <GlassTabsContent value="tab2">Content for Tab 2</GlassTabsContent>
    </GlassTabs>
  );
}

const meta = {
  title: 'Registries/EinUI/GlassTabs',
  component: GlassTabsDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassTabsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <GlassTabsDemo />,
};

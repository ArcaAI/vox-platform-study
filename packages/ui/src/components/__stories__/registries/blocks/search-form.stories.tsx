import type { Meta, StoryObj } from '@storybook/react-vite';

import { SearchForm } from '../../../registries/blocks/search-form';
import { SidebarProvider, Sidebar } from '../../../shadcn/sidebar';

const meta = {
  title: 'Registries/Blocks/SearchForm',
  component: SearchForm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <SidebarProvider>
        <Sidebar>
          <Story />
        </Sidebar>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof SearchForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

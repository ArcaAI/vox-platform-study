import type { Meta, StoryObj } from '@storybook/react-vite';

import { PreferencesPanel } from '../../../registries/tool-ui/preferences-panel';

const meta = {
  title: 'Registries/ToolUI/PreferencesPanel',
  component: PreferencesPanel,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PreferencesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    sections: [
      {
        heading: 'General',
        items: [
          {
            id: 'theme',
            label: 'Dark Mode',
            type: 'switch',
          },
        ],
      },
    ],
  },
};

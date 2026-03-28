import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  PlayIcon,
  PauseIcon,
  VolumeIcon,
  MicIcon,
  MicOffIcon,
  MailCheckIcon,
  MessageCircleIcon,
  MessageSquareIcon,
} from '@/components/registries/lucide-animated';

const icons = [
  { name: 'play', Icon: PlayIcon },
  { name: 'pause', Icon: PauseIcon },
  { name: 'volume', Icon: VolumeIcon },
  { name: 'mic', Icon: MicIcon },
  { name: 'mic-off', Icon: MicOffIcon },
  { name: 'mail-check', Icon: MailCheckIcon },
  { name: 'message-circle', Icon: MessageCircleIcon },
  { name: 'message-square', Icon: MessageSquareIcon },
] as const;

function MediaIcons() {
  return (
    <div className="grid grid-cols-6 gap-6 p-6">
      {icons.map(({ name, Icon }) => (
        <div key={name} className="flex flex-col items-center gap-2">
          <Icon className="h-8 w-8" />
          <span className="text-xs text-muted-foreground">{name}</span>
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Registries/LucideAnimated/Media',
  component: MediaIcons,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MediaIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  BellIcon,
  CircleCheckIcon,
  ShieldCheckIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  LockOpenIcon,
  ZapIcon,
  HeartIcon,
  SparklesIcon,
} from "@/components/registries/lucide-animated";

const icons = [
  { name: "bell", Icon: BellIcon },
  { name: "circle-check", Icon: CircleCheckIcon },
  { name: "shield-check", Icon: ShieldCheckIcon },
  { name: "eye", Icon: EyeIcon },
  { name: "eye-off", Icon: EyeOffIcon },
  { name: "lock", Icon: LockIcon },
  { name: "lock-open", Icon: LockOpenIcon },
  { name: "zap", Icon: ZapIcon },
  { name: "heart", Icon: HeartIcon },
  { name: "sparkles", Icon: SparklesIcon },
] as const;

function StatusIcons() {
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
  title: "Registries/LucideAnimated/Status",
  component: StatusIcons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof StatusIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

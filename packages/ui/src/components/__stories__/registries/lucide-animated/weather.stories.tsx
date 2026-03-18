import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  SunIcon,
  MoonIcon,
  CloudRainIcon,
  CloudSunIcon,
  SnowflakeIcon,
  WindIcon,
  CompassIcon,
  MapPinIcon,
  KeyIcon,
  FingerprintIcon,
} from "@/components/registries/lucide-animated";

const icons = [
  { name: "sun", Icon: SunIcon },
  { name: "moon", Icon: MoonIcon },
  { name: "cloud-rain", Icon: CloudRainIcon },
  { name: "cloud-sun", Icon: CloudSunIcon },
  { name: "snowflake", Icon: SnowflakeIcon },
  { name: "wind", Icon: WindIcon },
  { name: "compass", Icon: CompassIcon },
  { name: "map-pin", Icon: MapPinIcon },
  { name: "key", Icon: KeyIcon },
  { name: "fingerprint", Icon: FingerprintIcon },
] as const;

function WeatherIcons() {
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
  title: "Registries/LucideAnimated/Weather",
  component: WeatherIcons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WeatherIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

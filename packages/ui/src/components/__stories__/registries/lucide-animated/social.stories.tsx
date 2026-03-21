import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  UserIcon,
  UsersIcon,
  UserCheckIcon,
  GithubIcon,
  TwitterIcon,
  LinkedinIcon,
  InstagramIcon,
  YoutubeIcon,
  FigmaIcon,
  ChromeIcon,
} from "@/components/registries/lucide-animated";

const icons = [
  { name: "user", Icon: UserIcon },
  { name: "users", Icon: UsersIcon },
  { name: "user-check", Icon: UserCheckIcon },
  { name: "github", Icon: GithubIcon },
  { name: "twitter", Icon: TwitterIcon },
  { name: "linkedin", Icon: LinkedinIcon },
  { name: "instagram", Icon: InstagramIcon },
  { name: "youtube", Icon: YoutubeIcon },
  { name: "figma", Icon: FigmaIcon },
  { name: "chrome", Icon: ChromeIcon },
] as const;

function SocialIcons() {
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
  title: "Registries/LucideAnimated/Social",
  component: SocialIcons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SocialIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

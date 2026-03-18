import type { Meta, StoryObj } from "@storybook/react-vite";
import { PricingTableTwo } from "@/components/registries/billingsdk";
import { plans } from "@/lib/billingsdk-config";

const meta = {
  title: "Registries/BillingSDK/PricingTableTwo",
  component: PricingTableTwo,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
} satisfies Meta<typeof PricingTableTwo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    plans,
  },
};

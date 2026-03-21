import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import { PaymentSuccessDialog } from "@/components/registries/billingsdk";

const meta = {
  title: "Registries/BillingSDK/PaymentSuccessDialog",
  component: PaymentSuccessDialog,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
} satisfies Meta<typeof PaymentSuccessDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    price: "19.99",
    productName: "Pro Plan",
  },
  render: (args) => {
    const ref = useRef<{ open: () => void; close: () => void }>(null);
    return (
      <div className="flex flex-col gap-4">
        <Button onClick={() => ref.current?.open()}>Open</Button>
        <PaymentSuccessDialog ref={ref} {...args} />
      </div>
    );
  },
};

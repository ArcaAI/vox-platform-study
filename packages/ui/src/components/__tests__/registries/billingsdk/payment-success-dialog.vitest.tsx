import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaymentSuccessDialog } from "@/components/registries/billingsdk";

describe("PaymentSuccessDialog", () => {
  it("renders without crashing", () => {
    render(
      <PaymentSuccessDialog
        price="19.99"
        productName="Pro Plan"
        open={true}
      />
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

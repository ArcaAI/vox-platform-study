import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UpdatePlanDialog } from "@/components/registries/billingsdk";
import { plans } from "@/lib/billingsdk-config";

describe("UpdatePlanDialog", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <UpdatePlanDialog
        currentPlan={plans[0]}
        plans={plans}
        triggerText="Change"
        onPlanChange={() => {}}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

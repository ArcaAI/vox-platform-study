import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UsageMeter } from "@/components/registries/billingsdk";

describe("UsageMeter", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <UsageMeter usage={[{ name: "API", usage: 50, limit: 100 }]} />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

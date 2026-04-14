import { describe, it, expect } from "vitest";
import { ProjectContextManager } from "../project-context.js";

describe("ProjectContextManager.getBrandForProject", () => {
  it("returns brand mapping when registered", () => {
    const manager = new ProjectContextManager();
    manager.registerBrand("project-123", { brand: "acme", series: "weekly" });
    const result = manager.getBrandForProject("project-123");
    expect(result).toEqual({ brand: "acme", series: "weekly" });
  });

  it("returns null for unknown project", () => {
    const manager = new ProjectContextManager();
    const result = manager.getBrandForProject("unknown");
    expect(result).toBeNull();
  });
});

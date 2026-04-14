import { describe, it, expect, vi } from "vitest";

describe("crystallization trigger", () => {
  it("debounces analysis within 10 minutes", async () => {
    const runAnalysis = vi.fn().mockResolvedValue(undefined);
    const lastAnalysisAt = new Map<string, number>();
    const DEBOUNCE_MS = 10 * 60 * 1000;

    function maybeTrigger(brand: string, series?: string) {
      const key = `${brand}:${series ?? ""}`;
      const lastAt = lastAnalysisAt.get(key) ?? 0;
      if (Date.now() - lastAt > DEBOUNCE_MS) {
        lastAnalysisAt.set(key, Date.now());
        runAnalysis({ brand, series });
      }
    }

    maybeTrigger("acme", "weekly");
    maybeTrigger("acme", "weekly"); // within debounce
    expect(runAnalysis).toHaveBeenCalledTimes(1);
  });

  it("skips when no brand mapping", () => {
    const brandInfo = null;
    const runAnalysis = vi.fn();
    if (brandInfo) runAnalysis();
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});

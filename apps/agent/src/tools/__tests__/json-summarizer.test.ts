import { describe, it, expect } from "vitest";
import { summarizeJson } from "../json-summarizer.js";

describe("summarizeJson", () => {
  it("preserves top-level keys for objects", () => {
    const input = {
      name: "test",
      count: 42,
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };
    const result = summarizeJson(input);

    expect(result).toContain("name");
    expect(result).toContain("count");
    expect(result).toContain("items");
  });

  it("truncates arrays to first 3 elements with count", () => {
    const input = {
      items: Array.from({ length: 20 }, (_, i) => `item-${i}`),
    };
    const result = summarizeJson(input);

    expect(result).toContain("item-0");
    expect(result).toContain("item-1");
    expect(result).toContain("item-2");
    expect(result).toContain("...and 17 more");
    expect(result).not.toContain("item-3");
  });

  it("does not add '...and N more' for arrays with 3 or fewer elements", () => {
    const input = { items: ["a", "b", "c"] };
    const result = summarizeJson(input);

    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
    expect(result).not.toContain("...and");
  });

  it("handles nested objects", () => {
    const input = {
      user: { name: "Alice", age: 30, settings: { theme: "dark" } },
    };
    const result = summarizeJson(input);

    expect(result).toContain("user");
    expect(result).toContain("name");
  });

  it("handles null and undefined values", () => {
    const input = { a: null, b: undefined, c: "value" };
    const result = summarizeJson(input);

    expect(result).toContain("a");
    expect(result).toContain("c");
  });

  it("handles primitive inputs", () => {
    expect(summarizeJson("hello")).toBe('"hello"');
    expect(summarizeJson(42)).toBe("42");
    expect(summarizeJson(null)).toBe("null");
    expect(summarizeJson(true)).toBe("true");
  });

  it("truncates result to maxChars", () => {
    const input = {
      a: "long value ".repeat(100),
      b: "another long value ".repeat(100),
    };
    const result = summarizeJson(input, 200);

    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain("...(truncated)");
  });

  it("handles top-level arrays", () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const result = summarizeJson(input);

    expect(result).toContain("id");
    expect(result).toContain("...and 7 more");
  });

  it("handles empty objects and arrays", () => {
    expect(summarizeJson({})).toBe("{}");
    expect(summarizeJson([])).toBe("[]");
  });
});

import { describe, it, expect } from "vitest";
import { parseScope } from "../scope-parser.js";

describe("parseScope", () => {
  it("parses brand-only scope", () => {
    expect(parseScope("brand:acme")).toEqual({ brand: "acme" });
  });

  it("parses brand+series scope", () => {
    expect(parseScope("brand:acme/series:weekly")).toEqual({
      brand: "acme",
      series: "weekly",
    });
  });

  it("returns empty for global scope", () => {
    expect(parseScope("global")).toEqual({});
  });

  it("returns empty for undefined", () => {
    expect(parseScope(undefined)).toEqual({});
  });

  it("returns empty for empty string", () => {
    expect(parseScope("")).toEqual({});
  });
});

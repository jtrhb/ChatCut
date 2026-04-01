import { describe, it, expect, beforeEach } from "vitest";
import { ExtensionRegistry } from "../extension-registry.js";
import type { ExtensionManifest } from "../types.js";

function makeExtension(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "ext-1",
    name: "Test Extension",
    type: "tool",
    version: "1.0.0",
    description: "A test extension",
    enabled: true,
    ...overrides,
  };
}

describe("ExtensionRegistry", () => {
  let registry: ExtensionRegistry;

  beforeEach(() => {
    registry = new ExtensionRegistry();
  });

  describe("register()", () => {
    it("adds an extension to the registry", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      expect(registry.get("ext-1")).toBeDefined();
    });

    it("throws on duplicate ID", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      expect(() => registry.register(makeExtension({ id: "ext-1" }))).toThrow(/already registered/i);
    });
  });

  describe("get()", () => {
    it("returns undefined for unknown ID", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("unregister()", () => {
    it("removes an extension", () => {
      registry.register(makeExtension({ id: "ext-1" }));
      registry.unregister("ext-1");
      expect(registry.get("ext-1")).toBeUndefined();
    });
  });

  describe("listByType()", () => {
    it("returns extensions filtered by type", () => {
      registry.register(makeExtension({ id: "e1", type: "tool" }));
      registry.register(makeExtension({ id: "e2", type: "provider" }));
      registry.register(makeExtension({ id: "e3", type: "tool" }));
      expect(registry.listByType("tool")).toHaveLength(2);
      expect(registry.listByType("provider")).toHaveLength(1);
    });

    it("only returns enabled extensions by default", () => {
      registry.register(makeExtension({ id: "e1", type: "tool", enabled: true }));
      registry.register(makeExtension({ id: "e2", type: "tool", enabled: false }));
      expect(registry.listByType("tool")).toHaveLength(1);
    });

    it("returns all extensions when includeDisabled is true", () => {
      registry.register(makeExtension({ id: "e1", type: "tool", enabled: true }));
      registry.register(makeExtension({ id: "e2", type: "tool", enabled: false }));
      expect(registry.listByType("tool", { includeDisabled: true })).toHaveLength(2);
    });
  });

  describe("enable() / disable()", () => {
    it("toggles extension enabled state", () => {
      registry.register(makeExtension({ id: "e1", enabled: true }));
      registry.disable("e1");
      expect(registry.get("e1")!.enabled).toBe(false);
      registry.enable("e1");
      expect(registry.get("e1")!.enabled).toBe(true);
    });

    it("throws when enabling unknown ID", () => {
      expect(() => registry.enable("nonexistent")).toThrow(/not found/i);
    });

    it("throws when disabling unknown ID", () => {
      expect(() => registry.disable("nonexistent")).toThrow(/not found/i);
    });
  });

  describe("listAll()", () => {
    it("returns all registered extensions", () => {
      registry.register(makeExtension({ id: "e1" }));
      registry.register(makeExtension({ id: "e2" }));
      expect(registry.listAll()).toHaveLength(2);
    });
  });
});

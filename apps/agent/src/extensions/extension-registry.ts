import type { ExtensionManifest, ExtensionType } from "./types.js";

export class ExtensionRegistry {
  private extensions = new Map<string, ExtensionManifest>();

  register(manifest: ExtensionManifest): void {
    if (this.extensions.has(manifest.id)) {
      throw new Error(`Extension already registered: ${manifest.id}`);
    }
    this.extensions.set(manifest.id, { ...manifest });
  }

  unregister(id: string): void {
    this.extensions.delete(id);
  }

  get(id: string): ExtensionManifest | undefined {
    const ext = this.extensions.get(id);
    return ext ? { ...ext } : undefined;
  }

  enable(id: string): void {
    const ext = this.extensions.get(id);
    if (ext) ext.enabled = true;
  }

  disable(id: string): void {
    const ext = this.extensions.get(id);
    if (ext) ext.enabled = false;
  }

  listByType(type: ExtensionType, opts?: { includeDisabled?: boolean }): ExtensionManifest[] {
    return Array.from(this.extensions.values())
      .filter((e) => e.type === type)
      .filter((e) => opts?.includeDisabled || e.enabled)
      .map((e) => ({ ...e }));
  }

  listAll(): ExtensionManifest[] {
    return Array.from(this.extensions.values()).map((e) => ({ ...e }));
  }
}

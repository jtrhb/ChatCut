export type ExtensionType = "tool" | "provider" | "brand" | "skill" | "hook";

export interface ExtensionManifest {
  id: string;
  name: string;
  type: ExtensionType;
  version: string;
  description: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

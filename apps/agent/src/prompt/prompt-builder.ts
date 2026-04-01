import type { PromptSection, PromptContext } from "./types.js";
import { BUILTIN_SECTIONS } from "./sections.js";

export interface PromptBuilderOptions {
  /** When false, no built-in sections are registered. Defaults to true. */
  builtins?: boolean;
}

export class PromptBuilder {
  private sections: PromptSection[] = [];

  constructor(options: PromptBuilderOptions = {}) {
    const { builtins = true } = options;
    if (builtins) {
      // Register built-in sections
      for (const section of BUILTIN_SECTIONS) {
        this.sections.push(section);
      }
    }
  }

  /** Register a custom section. Replaces any existing section with the same key. */
  register(section: PromptSection): void {
    this.sections = this.sections.filter((s) => s.key !== section.key);
    this.sections.push(section);
  }

  /** Build the full system prompt from all registered sections. */
  build(ctx: PromptContext): string {
    const sorted = [...this.sections].sort(
      (a, b) => (a.priority ?? 50) - (b.priority ?? 50),
    );

    const rendered: string[] = [];
    for (const section of sorted) {
      const content = section.render(ctx);
      if (content) {
        rendered.push(content);
      }
    }

    return rendered.join("\n").trimEnd() + "\n";
  }
}

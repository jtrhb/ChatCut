import type { PromptSection, PromptContext } from "./types.js";

export const identitySection: PromptSection = {
  key: "identity",
  priority: 0,
  isStatic: true,
  render: (ctx: PromptContext): string => {
    const { role, description, rules } = ctx.agentIdentity;
    const lines = [`# ${role}`, "", description, ""];
    if (rules.length > 0) {
      lines.push("## Rules", ...rules.map((r) => `- ${r}`), "");
    }
    return lines.join("\n");
  },
};

export const timelineSection: PromptSection = {
  key: "timeline",
  priority: 10,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    if (!ctx.projectContext) return "";
    const { timelineState, snapshotVersion } = ctx.projectContext;
    const lines = [
      "## Current Timeline State",
      timelineState || "(empty timeline)",
      `Snapshot version: ${snapshotVersion}`,
      "",
    ];
    return lines.join("\n");
  },
};

export const memorySection: PromptSection = {
  key: "memory",
  priority: 20,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    if (!ctx.projectContext) return "";
    const { promptText, injectedMemoryIds } = ctx.projectContext.memoryContext;
    if (!promptText) return "";
    const lines = ["## Memory Context", promptText];
    if (injectedMemoryIds.length > 0) {
      lines.push(`Active memory IDs: ${injectedMemoryIds.join(", ")}`);
    }
    lines.push("");
    return lines.join("\n");
  },
};

export const recentChangesSection: PromptSection = {
  key: "recentChanges",
  priority: 30,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    const { recentChanges } = ctx.projectContext;
    if (recentChanges.length === 0) return "";
    const lines = ["## Recent Changes"];
    for (const change of recentChanges) {
      lines.push(`- [${change.source}] ${change.summary}`);
    }
    lines.push("");
    return lines.join("\n");
  },
};

export const taskSection: PromptSection = {
  key: "task",
  priority: 80,
  isStatic: false,
  render: (ctx: PromptContext): string => {
    if (!ctx.task) return "";
    const lines = ["## Task", ctx.task.task];
    if (ctx.task.context && Object.keys(ctx.task.context).length > 0) {
      lines.push("", "## Context", JSON.stringify(ctx.task.context, null, 2));
    }
    lines.push("");
    return lines.join("\n");
  },
};

/** All built-in sections in registration order. */
export const BUILTIN_SECTIONS: PromptSection[] = [
  identitySection,
  timelineSection,
  memorySection,
  recentChangesSection,
  taskSection,
];

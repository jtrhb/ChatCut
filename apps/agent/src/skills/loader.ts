import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ParsedMemory } from "../memory/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { SkillRuntime } from "./skill-runtime.js";
import type { SkillContract, SkillFrontmatter } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, "presets");

export class SkillLoader {
  private readonly store: MemoryStore | null;

  constructor(store: MemoryStore | null) {
    this.store = store;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load skills from R2 _skills/ paths filtered by agentType.
   * Excludes skills with skill_status === "deprecated".
   * Returns empty array when store is null (preset-only mode).
   */
  async loadSkills(
    agentType: string,
    params: { brand?: string; series?: string }
  ): Promise<ParsedMemory[]> {
    if (!this.store) return [];

    const paths = this.buildSkillPaths(params);
    const all: ParsedMemory[] = [];

    for (const dirPath of paths) {
      try {
        const files = await this.store.listDir(dirPath);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          try {
            const mem = await this.store.readParsed(`${dirPath}${file}`);
            all.push(mem);
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip missing directories
      }
    }

    return all.filter(
      (m) =>
        m.agent_type === agentType && m.skill_status !== "deprecated"
    );
  }

  /**
   * Load skills grouped by validation state.
   * mainSkills: skill_status === "validated"
   * trialSkills: skill_status === "draft"
   */
  async loadSkillsGrouped(
    agentType: string,
    params: { brand?: string; series?: string }
  ): Promise<{ mainSkills: ParsedMemory[]; trialSkills: ParsedMemory[] }> {
    const skills = await this.loadSkills(agentType, params);

    return {
      mainSkills: skills.filter((s) => s.skill_status === "validated"),
      trialSkills: skills.filter((s) => s.skill_status === "draft"),
    };
  }

  /**
   * Load skills and resolve their frontmatter into SkillContract objects
   * using SkillRuntime.
   */
  async loadSkillsWithContracts(
    agentType: string,
    params: { brand?: string; series?: string },
    runtimeOpts: { availableTools: string[]; defaultModel: string },
  ): Promise<SkillContract[]> {
    const skills = await this.loadSkills(agentType, params);
    const runtime = new SkillRuntime(runtimeOpts);

    return skills.map((skill) => {
      const frontmatter: SkillFrontmatter = {};
      if (skill.agent_type) {
        frontmatter.agent_type = skill.agent_type as any;
      }
      return runtime.resolve(skill, frontmatter);
    });
  }

  /**
   * Load system presets from the local presets/ directory.
   * Reads .md files, parses frontmatter, filters by agent_type.
   */
  async loadSystemPresets(agentType: string): Promise<ParsedMemory[]> {
    const files = this.listPresetFiles();
    const results: ParsedMemory[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(PRESETS_DIR, file), "utf-8");
        const mem = this.parseFrontmatter(raw);
        if (mem.agent_type === agentType) {
          results.push(mem);
        }
      } catch {
        // skip unreadable preset files
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildSkillPaths(params: { brand?: string; series?: string }): string[] {
    const paths: string[] = [];

    if (params.brand) {
      paths.push(`brands/${params.brand}/_skills/`);
      if (params.series) {
        paths.push(`brands/${params.brand}/series/${params.series}/_skills/`);
      }
    }

    return paths;
  }

  /** List files in the presets directory (mockable in tests). */
  protected listPresetFiles(): string[] {
    try {
      return readdirSync(PRESETS_DIR);
    } catch {
      return [];
    }
  }

  /**
   * Parse `---\nyaml\n---\ncontent` format into a ParsedMemory.
   * Mirrors the parser in MemoryStore but operates on a raw string
   * so we don't need a store instance for preset files.
   */
  private parseFrontmatter(raw: string): ParsedMemory {
    if (!raw.startsWith("---")) {
      throw new Error("Invalid preset file: missing frontmatter opening ---");
    }

    const afterOpen = raw.slice(3);
    const closeIdx = afterOpen.indexOf("\n---");
    if (closeIdx === -1) {
      throw new Error("Invalid preset file: missing frontmatter closing ---");
    }

    const yamlBlock = afterOpen.slice(0, closeIdx).trim();
    const content = afterOpen.slice(closeIdx + 4).trim();

    const fields: Record<string, unknown> = {};

    for (const line of yamlBlock.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      fields[key] = this.parseYamlValue(rawValue);
    }

    const mem: ParsedMemory = {
      memory_id: String(fields.memory_id ?? ""),
      type: (fields.type as ParsedMemory["type"]) ?? "knowledge",
      status: (fields.status as ParsedMemory["status"]) ?? "active",
      confidence: (fields.confidence as ParsedMemory["confidence"]) ?? "high",
      source: (fields.source as ParsedMemory["source"]) ?? "implicit",
      created: String(fields.created ?? ""),
      updated: String(fields.updated ?? ""),
      reinforced_count: Number(fields.reinforced_count ?? 0),
      last_reinforced_at: String(fields.last_reinforced_at ?? ""),
      source_change_ids: (fields.source_change_ids as string[]) ?? [],
      used_in_changeset_ids: (fields.used_in_changeset_ids as string[]) ?? [],
      created_session_id: String(fields.created_session_id ?? ""),
      scope: String(fields.scope ?? "global"),
      scope_level: (fields.scope_level as ParsedMemory["scope_level"]) ?? "global",
      semantic_key: String(fields.semantic_key ?? ""),
      tags: (fields.tags as string[]) ?? [],
      content,
    };

    if (fields.skill_id !== undefined) mem.skill_id = String(fields.skill_id);
    if (fields.skill_status !== undefined)
      mem.skill_status = fields.skill_status as ParsedMemory["skill_status"];
    if (fields.agent_type !== undefined)
      mem.agent_type = String(fields.agent_type);
    if (fields.applies_to !== undefined)
      mem.applies_to = fields.applies_to as string[];

    return mem;
  }

  private parseYamlValue(raw: string): unknown {
    if (raw === "") return "";
    if (raw.startsWith("[")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (raw.startsWith("{")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (raw === "true") return true;
    if (raw === "false") return false;
    const num = Number(raw);
    if (!isNaN(num) && raw !== "") return num;
    return raw;
  }
}

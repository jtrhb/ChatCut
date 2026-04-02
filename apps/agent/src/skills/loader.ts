import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ParsedMemory } from "../memory/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { SkillRuntime } from "./skill-runtime.js";
import type { SkillContract, SkillFrontmatter } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, "presets");

/** Check whether a ParsedMemory's agent_type (string or string[]) matches a target. */
function agentTypeMatches(
  memAgentType: string | string[] | undefined,
  target: string,
): boolean {
  if (memAgentType === undefined) return false;
  return Array.isArray(memAgentType)
    ? memAgentType.includes(target)
    : memAgentType === target;
}

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
        agentTypeMatches(m.agent_type, agentType) && m.skill_status !== "deprecated"
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

    return skills.map((skill) => runtime.resolve(skill, this.buildFrontmatter(skill)));
  }

  /**
   * Load both store skills and system presets, resolve all through SkillRuntime,
   * and return a unified array of SkillContract objects.
   */
  async loadAllSkillContracts(
    agentType: string,
    params: { brand?: string; series?: string },
    runtimeOpts: { availableTools: string[]; defaultModel: string },
  ): Promise<SkillContract[]> {
    const runtime = new SkillRuntime(runtimeOpts);

    const [storeSkills, presetSkills] = await Promise.all([
      this.loadSkills(agentType, params),
      this.loadSystemPresets(agentType),
    ]);

    const allSkills = [...storeSkills, ...presetSkills];

    return allSkills.map((skill) => runtime.resolve(skill, this.buildFrontmatter(skill)));
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
        const mem = parseFrontmatter(raw);
        if (agentTypeMatches(mem.agent_type, agentType)) {
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

  /** Map a ParsedMemory's skill fields to a SkillFrontmatter object. */
  private buildFrontmatter(skill: ParsedMemory): SkillFrontmatter {
    const frontmatter: SkillFrontmatter = {};
    if (skill.agent_type) frontmatter.agent_type = skill.agent_type as SkillFrontmatter["agent_type"];
    if (skill.allowed_tools) frontmatter.allowed_tools = skill.allowed_tools;
    if (skill.denied_tools) frontmatter.denied_tools = skill.denied_tools;
    if (skill.skill_model) frontmatter.model = skill.skill_model;
    if (skill.effort) frontmatter.effort = skill.effort;
    if (skill.when_to_use) frontmatter.when_to_use = skill.when_to_use;
    if (skill.execution_context) frontmatter.execution_context = skill.execution_context;
    if (skill.skill_hooks) frontmatter.hooks = skill.skill_hooks;
    return frontmatter;
  }

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

}

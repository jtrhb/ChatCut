import { randomUUID } from "crypto";
import type { ParsedMemory } from "./types.js";

/** Read-only surface PatternObserver needs. Writes go through the injected
 *  writer callback so MasterAgent remains the sole memory writer (spec §9.4). */
interface MemoryReader {
  listDir(path: string): Promise<string[]>;
  readParsed(path: string): Promise<ParsedMemory>;
}

type MemoryWriter = (path: string, memory: ParsedMemory) => Promise<void>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PatternAnalysis {
  clusters: Array<{
    tags: string[];
    memories: ParsedMemory[];
    confidence: "high" | "medium" | "low";
  }>;
  totalMemories: number;
  highConfidenceCount: number;
}

export interface CrystallizeSkillParams {
  memories: ParsedMemory[];
  name: string;
  agentType: string;
  scopeLevel: "brand" | "series";
  scopeRef: string; // e.g. "brand:coffee-lab"
}

// ---------------------------------------------------------------------------
// PatternObserver
// ---------------------------------------------------------------------------

export class PatternObserver {
  private readonly reader: MemoryReader;
  private readonly writeMemory: MemoryWriter;

  constructor(deps: { memoryReader: MemoryReader; writeMemory: MemoryWriter }) {
    this.reader = deps.memoryReader;
    this.writeMemory = deps.writeMemory;
  }

  // ── analyzePatterns ──────────────────────────────────────────────────────

  async analyzePatterns(memories: ParsedMemory[]): Promise<PatternAnalysis> {
    const highConfidenceCount = memories.filter(
      (m) => m.confidence === "high"
    ).length;

    // Build a map from tag-pair key → matching memories
    // We cluster by finding all unique tag combinations shared by 2+ memories
    const tagPairMap = new Map<string, ParsedMemory[]>();

    for (const memory of memories) {
      const tags = memory.tags;
      // Generate all pairs of tags to find shared tag groups
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const key = [tags[i], tags[j]].sort().join("|");
          if (!tagPairMap.has(key)) tagPairMap.set(key, []);
          tagPairMap.get(key)!.push(memory);
        }
        // Also index single tags for single-tag clusters
        const singleKey = tags[i];
        if (!tagPairMap.has(singleKey)) tagPairMap.set(singleKey, []);
        tagPairMap.get(singleKey)!.push(memory);
      }
    }

    // Deduplicate clusters — prefer the largest cluster per unique memory set
    const seen = new Set<string>();
    const clusters: PatternAnalysis["clusters"] = [];

    for (const [key, clusterMemories] of tagPairMap) {
      if (clusterMemories.length < 2) continue;

      // Deduplicate members
      const unique = Array.from(
        new Map(clusterMemories.map((m) => [m.memory_id, m])).values()
      );

      const fingerprint = unique
        .map((m) => m.memory_id)
        .sort()
        .join(",");
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const tags = key.includes("|") ? key.split("|") : [key];
      const highCount = unique.filter((m) => m.confidence === "high").length;
      const clusterConfidence: "high" | "medium" | "low" =
        highCount / unique.length >= 0.7
          ? "high"
          : highCount / unique.length >= 0.4
          ? "medium"
          : "low";

      clusters.push({ tags, memories: unique, confidence: clusterConfidence });
    }

    // Sort clusters: largest first
    clusters.sort((a, b) => b.memories.length - a.memories.length);

    return {
      clusters,
      totalMemories: memories.length,
      highConfidenceCount,
    };
  }

  // ── shouldCrystallize ────────────────────────────────────────────────────

  shouldCrystallize(memories: ParsedMemory[]): {
    should: boolean;
    cluster?: ParsedMemory[];
    sharedTags?: string[];
  } {
    const highConf = memories.filter((m) => m.confidence === "high");

    if (highConf.length < 5) {
      return { should: false };
    }

    // Find the first tag combination where 5+ high-confidence memories share 2+ tags
    const tagCountMap = new Map<string, ParsedMemory[]>();

    for (const memory of highConf) {
      for (const tag of memory.tags) {
        if (!tagCountMap.has(tag)) tagCountMap.set(tag, []);
        tagCountMap.get(tag)!.push(memory);
      }
    }

    // Find tags that appear in 5+ high-confidence memories
    const qualifyingTags: string[] = [];
    for (const [tag, tagMemories] of tagCountMap) {
      if (tagMemories.length >= 5) {
        qualifyingTags.push(tag);
      }
    }

    if (qualifyingTags.length < 2) {
      return { should: false };
    }

    // Find the cluster: memories that share all qualifying tags
    const [firstTag, secondTag] = qualifyingTags;
    const cluster = highConf.filter(
      (m) => m.tags.includes(firstTag) && m.tags.includes(secondTag)
    );

    if (cluster.length < 5) {
      return { should: false };
    }

    return {
      should: true,
      cluster,
      sharedTags: qualifyingTags,
    };
  }

  // ── crystallizeSkill ─────────────────────────────────────────────────────

  async crystallizeSkill(params: CrystallizeSkillParams): Promise<ParsedMemory> {
    const { memories, name, agentType, scopeLevel, scopeRef } = params;

    // Gather shared tags across all source memories
    const tagFrequency = new Map<string, number>();
    for (const m of memories) {
      for (const tag of m.tags) {
        tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
      }
    }
    const appliesTo = Array.from(tagFrequency.entries())
      .filter(([, count]) => count >= Math.ceil(memories.length / 2))
      .map(([tag]) => tag);

    const skillId = randomUUID();
    const now = new Date().toISOString();
    const sourceMemoryIds = memories.map((m) => m.memory_id);

    // Build skill content
    const contentLines = [
      `# Skill: ${name}`,
      ``,
      `Agent: ${agentType}`,
      `Scope: ${scopeRef}`,
      `Applies to: ${appliesTo.join(", ")}`,
      ``,
      `## Source Memories`,
      ...sourceMemoryIds.map((id) => `- ${id}`),
      ``,
      `## Synthesized Guidance`,
      ...memories.map((m) => `- ${m.content}`),
    ];
    const content = contentLines.join("\n");

    const skill: ParsedMemory = {
      memory_id: randomUUID(),
      type: "preference",
      status: "active",
      confidence: "high",
      source: "observed",
      created: now,
      updated: now,
      reinforced_count: 0,
      last_reinforced_at: now,
      source_change_ids: [],
      used_in_changeset_ids: [],
      created_session_id: "pattern-observer",
      scope: scopeRef,
      scope_level: scopeLevel,
      semantic_key: name,
      tags: appliesTo,
      // Skill-specific fields
      skill_id: skillId,
      skill_status: "draft",
      agent_type: agentType,
      applies_to: appliesTo,
      content,
    };

    // Determine the write path based on scope
    const basePath = scopeRef.startsWith("series:")
      ? `brands/${scopeRef.replace("series:", "").split(":")[0] ?? "unknown"}/_skills/${name}.md`
      : `brands/${scopeRef.replace("brand:", "")}/_skills/${name}.md`;

    await this.writeMemory(basePath, skill);

    return skill;
  }

  // ── runAnalysis ──────────────────────────────────────────────────────────

  async runAnalysis(params: {
    brand: string;
    series?: string;
  }): Promise<{ skillsCreated: number }> {
    const { brand, series } = params;

    // Load all memories for the scope
    const dirPath = series
      ? `brands/${brand}/series/${series}/`
      : `brands/${brand}/`;

    const filenames = await this.reader.listDir(dirPath);
    const memories: ParsedMemory[] = [];

    for (const filename of filenames) {
      if (!filename.endsWith(".md")) continue;
      try {
        const mem = await this.reader.readParsed(`${dirPath}${filename}`);
        memories.push(mem);
      } catch {
        // Skip unreadable files
      }
    }

    const { should, cluster, sharedTags } = this.shouldCrystallize(memories);

    if (!should || !cluster || !sharedTags) {
      return { skillsCreated: 0 };
    }

    const scopeLevel = series ? "series" : "brand";
    const scopeRef = series ? `series:${series}` : `brand:${brand}`;
    const skillName = sharedTags.join("-") + "-skill";

    await this.crystallizeSkill({
      memories: cluster,
      name: skillName,
      agentType: "master",
      scopeLevel,
      scopeRef,
    });

    return { skillsCreated: 1 };
  }
}

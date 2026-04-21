import type { ParsedMemory, ConflictMarker } from "../memory/types.js";

/**
 * Parse `---\nyaml\n---\ncontent` format into a ParsedMemory.
 *
 * **Format contract:** This is a JSON-compatible frontmatter subset, NOT
 * full YAML. Each line is `key: value`. Arrays and objects must use inline
 * JSON syntax: `allowed_tools: ["trim_element", "split_element"]`.
 * Multi-line YAML list syntax (`- item` on separate lines) is NOT supported.
 */
export function parseFrontmatter(raw: string): ParsedMemory {
  if (!raw.startsWith("---")) {
    throw new Error("Invalid memory file: missing frontmatter opening ---");
  }

  // Find the closing ---
  const afterOpen = raw.slice(3); // skip opening ---
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) {
    throw new Error("Invalid memory file: missing frontmatter closing ---");
  }

  const yamlBlock = afterOpen.slice(0, closeIdx).trim();
  // Content starts after the closing ---\n
  const content = afterOpen.slice(closeIdx + 4).trim(); // +4 for "\n---"

  const fields: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    fields[key] = parseYamlValue(rawValue);
  }

  // Build the ParsedMemory — required fields with safe fallbacks
  const mem: ParsedMemory = {
    memory_id: String(fields.memory_id ?? ""),
    type: (fields.type as ParsedMemory["type"]) ?? "knowledge",
    status: (fields.status as ParsedMemory["status"]) ?? "draft",
    confidence: (fields.confidence as ParsedMemory["confidence"]) ?? "low",
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

  // Optional memory fields
  if (fields.last_used_at !== undefined) {
    mem.last_used_at = String(fields.last_used_at);
  }
  if (fields.last_reinforced_session_id !== undefined) {
    mem.last_reinforced_session_id = String(fields.last_reinforced_session_id);
  }
  if (fields.activation_scope !== undefined) {
    mem.activation_scope = fields.activation_scope as ParsedMemory["activation_scope"];
  }
  if (fields.skill_id !== undefined) {
    mem.skill_id = String(fields.skill_id);
  }
  if (fields.skill_status !== undefined) {
    mem.skill_status = fields.skill_status as ParsedMemory["skill_status"];
  }
  if (fields.agent_type !== undefined) {
    mem.agent_type = Array.isArray(fields.agent_type)
      ? (fields.agent_type as string[])
      : String(fields.agent_type);
  }
  if (fields.applies_to !== undefined) {
    mem.applies_to = fields.applies_to as string[];
  }

  // Skill runtime frontmatter
  if (fields.allowed_tools !== undefined) {
    mem.allowed_tools = fields.allowed_tools as string[];
  }
  if (fields.denied_tools !== undefined) {
    mem.denied_tools = fields.denied_tools as string[];
  }
  if (fields.model !== undefined) {
    mem.skill_model = String(fields.model);
  }
  if (fields.effort !== undefined) {
    mem.effort = fields.effort as ParsedMemory["effort"];
  }
  if (fields.when_to_use !== undefined) {
    mem.when_to_use = fields.when_to_use as string[];
  }
  if (fields.execution_context !== undefined) {
    mem.execution_context = fields.execution_context as ParsedMemory["execution_context"];
  }
  if (fields.hooks !== undefined) {
    mem.skill_hooks = fields.hooks as string[];
  }

  return mem;
}

/**
 * Phase 5c: parse a `---\nyaml\n---\nbody` conflict marker file. Same
 * frontmatter format as ParsedMemory, different field shape — body is the
 * marker's free-text reason, not a memory's content payload.
 *
 * Required fields: marker_id, action_type, target, severity, first_seen_at,
 * last_seen_at. conflicts_with defaults to []. Throws on missing frontmatter
 * delimiters so the caller (memory-loader) can skip the file via its existing
 * try/catch policy without ambiguity about whether parsing succeeded.
 */
export function parseConflictMarker(raw: string): ConflictMarker {
  if (!raw.startsWith("---")) {
    throw new Error("Invalid conflict marker: missing frontmatter opening ---");
  }

  const afterOpen = raw.slice(3);
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) {
    throw new Error("Invalid conflict marker: missing frontmatter closing ---");
  }

  const yamlBlock = afterOpen.slice(0, closeIdx).trim();
  const reason = afterOpen.slice(closeIdx + 4).trim();

  const fields: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    fields[key] = parseYamlValue(rawValue);
  }

  // Phase 5c MED-3: a misfiled ParsedMemory under `_conflicts/` would have
  // parsed to a degenerate marker (marker_id="", action_type="unknown") and
  // silently polluted the "do not repeat" prompt section with arbitrary
  // memory content. Treat the marker-shape required fields as load-bearing —
  // throw if any are missing so the loader's per-file try/catch skips the
  // file. The file stays on disk for a human to investigate.
  if (!fields.marker_id) {
    throw new Error(
      "Invalid conflict marker: missing marker_id (file may be a misfiled memory)",
    );
  }
  if (!fields.action_type) {
    throw new Error("Invalid conflict marker: missing action_type");
  }
  if (!fields.first_seen_at) {
    throw new Error("Invalid conflict marker: missing first_seen_at");
  }

  return {
    marker_id: String(fields.marker_id),
    action_type: String(fields.action_type),
    target: String(fields.target ?? "*"),
    severity: (fields.severity as ConflictMarker["severity"]) ?? "low",
    conflicts_with: (fields.conflicts_with as string[]) ?? [],
    first_seen_at: String(fields.first_seen_at),
    last_seen_at: String(fields.last_seen_at ?? fields.first_seen_at),
    reason,
  };
}

/** Parse a single YAML scalar value: number, boolean, JSON array/object/string, or plain string. */
export function parseYamlValue(raw: string): unknown {
  if (raw === "") return "";

  // JSON array
  if (raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  // JSON object
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  // Phase 5c MED-2: JSON-quoted string. Lets serializers emit
  // `"foo:bar"` so values containing `:`, `\n`, or other special chars
  // round-trip without truncation.
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to plain-string treatment
    }
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Number (integer or float)
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;

  // Plain string
  return raw;
}

/**
 * Phase 5c MED-2: serialize a string scalar for frontmatter, JSON-encoding
 * when the value would otherwise be misparsed (contains `:`, newline, leading
 * special char, or matches a reserved literal). Safe round-trip with
 * parseYamlValue. Use for any user-influenced string field.
 */
export function serializeYamlScalar(value: string): string {
  // Anything with a colon, newline, carriage return, leading special char,
  // or that parses as a non-string literal needs JSON-quoting.
  const needsQuoting =
    value.includes(":") ||
    value.includes("\n") ||
    value.includes("\r") ||
    /^[\[\{"]/.test(value) ||
    value === "true" ||
    value === "false" ||
    value === "" ||
    !isNaN(Number(value));
  return needsQuoting ? JSON.stringify(value) : value;
}

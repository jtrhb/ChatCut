import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").default("Untitled").notNull(),
  snapshotVersion: integer("snapshot_version").default(0).notNull(),
  timelineSnapshot: jsonb("timeline_snapshot"),
  // FK with onDelete: set null — change_log retention may evict rows;
  // a dangling pointer would corrupt the projects table, so we let the
  // pointer go null and treat "no last committed change" as the safe
  // post-retention state. uuid (not text) so type matches change_log.id.
  lastCommittedChangeId: uuid("last_committed_change_id").references(
    () => changeLog.id,
    { onDelete: "set null" },
  ),
  settings: jsonb("settings"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const changeLog = pgTable(
  "change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    sequence: integer("sequence").notNull(),
    source: text("source").notNull(), // "human" | "agent" | "system"
    agentId: text("agent_id"),
    changesetId: text("changeset_id"),
    actionType: text("action_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details"),
    summary: text("summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // (projectId, sequence) is the canonical replay-order key. Unique so
    // the SELECT-max-then-INSERT pattern in DrizzleMutationDB cannot
    // silently produce two rows with the same sequence under concurrent
    // writes — the second INSERT raises a unique-violation that aborts
    // the second tx (the first one's swap still lands cleanly).
    uniqueIndex("change_log_project_sequence_uniq").on(table.projectId, table.sequence),
    index("change_log_changeset_idx").on(table.changesetId),
  ]
);

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id),
  userId: text("user_id").notNull(),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  duration: integer("duration"),
  width: integer("width"),
  height: integer("height"),
  checksum: text("checksum"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  userId: text("user_id").notNull(),
  status: text("status").default("active").notNull(),
  lastMessageAt: timestamp("last_message_at"),
  contextSnapshot: jsonb("context_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pendingChangesets = pgTable("pending_changesets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  sessionId: uuid("session_id").references(() => agentSessions.id),
  boundaryCursor: integer("boundary_cursor").notNull(),
  status: text("status").default("pending").notNull(),
  summary: text("summary"),
  fingerprint: jsonb("fingerprint"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  decidedAt: timestamp("decided_at"),
});

export const visionCache = pgTable(
  "vision_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediaHash: text("media_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    analysis: jsonb("analysis").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Phase 5a MED-2 race fix: unique index on (mediaHash, schemaVersion)
    // so the executor's onConflictDoNothing INSERT actually fires. Pre-
    // Phase 5a this was a non-unique index and concurrent analyzers of
    // the same media would silently create duplicate rows. The analysis
    // for a given (hash, version) is deterministic, so first-writer-wins
    // is correct.
    uniqueIndex("vision_cache_media_hash_schema_uniq").on(
      table.mediaHash,
      table.schemaVersion
    ),
  ]
);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  storageKey: text("storage_key").notNull(),
  tags: jsonb("tags").default([]).notNull(),
  generationContext: jsonb("generation_context"),
  projectId: uuid("project_id").references(() => projects.id),
  embedding: vector("embedding"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const brandKits = pgTable("brand_kits", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  brandSlug: text("brand_slug"),
  visualConfig: jsonb("visual_config"),
  toneConfig: jsonb("tone_config"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    agentType: text("agent_type").notNull(),
    content: text("content").notNull(),
    frontmatter: jsonb("frontmatter"),
    skillStatus: text("skill_status").default("draft").notNull(),
    // Phase 5: Performance tracking
    approveCount: integer("approve_count").default(0).notNull(),
    rejectCount: integer("reject_count").default(0).notNull(),
    sessionsSeen: integer("sessions_seen").default(0).notNull(),
    consecutiveRejects: integer("consecutive_rejects").default(0).notNull(),
    createdSessionId: text("created_session_id"),
    lastSessionId: text("last_session_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("skills_agent_type_idx").on(table.agentType),
    index("skills_status_idx").on(table.skillStatus),
  ]
);

export const explorationSessions = pgTable("exploration_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  baseSnapshotVersion: integer("base_snapshot_version"),
  userIntent: text("user_intent"),
  candidates: jsonb("candidates"),
  // Phase 3 Stage E: maps candidateId → R2 storage key for the rendered
  // preview MP4. Worker writes per-candidate via jsonb_set on terminal
  // `done`. Route reads to mint signed URLs on demand (page reload).
  previewStorageKeys: jsonb("preview_storage_keys"),
  // Phase 3 Stage E: maps candidateId → {message, ts} when the GPU
  // service reported a real `failed` (or the agent synthesized a poll
  // timeout). Route serves this as 422 to distinguish "render failed"
  // from "still rendering" (404) and "infra down" (503).
  previewRenderFailures: jsonb("preview_render_failures"),
  selectedCandidateId: text("selected_candidate_id"),
  parentExplorationId: uuid("parent_exploration_id"),
  exposureOrder: jsonb("exposure_order"),
  status: text("status").default("queued").notNull(),
  memorySignals: jsonb("memory_signals"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const characterAssets = pgTable("character_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  characterId: uuid("character_id")
    .notNull()
    .references(() => characters.id),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id),
  role: text("role").default("reference").notNull(),
});

export const brandAssetLinks = pgTable("brand_asset_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brandKits.id),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id),
  assetRole: text("asset_role").notNull(),
});

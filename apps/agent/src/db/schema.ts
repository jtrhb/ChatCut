import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").default("Untitled").notNull(),
  snapshotVersion: integer("snapshot_version").default(0).notNull(),
  timelineSnapshot: jsonb("timeline_snapshot"),
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
    index("change_log_project_sequence_idx").on(table.projectId, table.sequence),
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
    index("vision_cache_media_hash_schema_idx").on(
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
  previewStorageKeys: jsonb("preview_storage_keys"),
  selectedCandidateId: text("selected_candidate_id"),
  parentExplorationId: uuid("parent_exploration_id"),
  exposureOrder: jsonb("exposure_order"),
  status: text("status").default("queued").notNull(),
  memorySignals: jsonb("memory_signals"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const missionStatus = [
  'draft',
  'planning',
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;
export type MissionStatus = (typeof missionStatus)[number];

export const backend = ['managed-agents', 'gateway'] as const;
export type Backend = (typeof backend)[number];

export const plannerStrategy = ['rule-based', 'llm', 'graph'] as const;
export type PlannerStrategy = (typeof plannerStrategy)[number];

export const taskStatus = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
  'merged',
  'abandoned',
  'failed',
] as const;
export type TaskStatus = (typeof taskStatus)[number];

export const missions = sqliteTable('missions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  goal: text('goal').notNull(),
  status: text('status', { enum: missionStatus }).notNull().default('draft'),
  backend: text('backend', { enum: backend }).notNull(),
  agentId: text('agent_id').notNull(),
  plannerStrategy: text('planner_strategy', { enum: plannerStrategy })
    .notNull()
    .default('rule-based'),
  targetRepos: text('target_repos', { mode: 'json' }).$type<string[]>(),
  concurrencyCap: integer('concurrency_cap').notNull().default(5),
  budgetUsd: integer('budget_usd'),
  budgetTokens: integer('budget_tokens'),
  budgetThresholdPct: integer('budget_threshold_pct').notNull().default(80),
  spentUsd: integer('spent_usd').notNull().default(0),
  spentTokens: integer('spent_tokens').notNull().default(0),
  autoMergePolicy: text('auto_merge_policy', { mode: 'json' }).$type<AutoMergePolicy>(),
  webhookSecret: text('webhook_secret').notNull(),
  githubInstallationId: text('github_installation_id'),
  githubVaultId: text('github_vault_id'),
  skillId: text('skill_id'),
  aiReviewEnabled: integer('ai_review_enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    baseBranch: text('base_branch').notNull().default('main'),
    promptVars: text('prompt_vars', { mode: 'json' }).$type<Record<string, unknown>>(),
    issueRef: text('issue_ref'),
    dependsOnIds: text('depends_on_ids', { mode: 'json' }).$type<string[]>(),
    status: text('status', { enum: taskStatus }).notNull().default('queued'),
    sessionId: text('session_id'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    diffAdditions: integer('diff_additions'),
    diffDeletions: integer('diff_deletions'),
    filesChanged: integer('files_changed'),
    retryCount: integer('retry_count').notNull().default(0),
    aiReviewRetryCount: integer('ai_review_retry_count').notNull().default(0),
    lastError: text('last_error'),
    costUsd: integer('cost_usd').notNull().default(0),
    costTokens: integer('cost_tokens').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    dispatchedAt: integer('dispatched_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('tasks_mission_status_idx').on(t.missionId, t.status),
    index('tasks_depends_on_idx').on(t.dependsOnIds),
    index('tasks_session_idx').on(t.sessionId),
  ],
);

export const ledgerEvents = sqliteTable(
  'ledger_events',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    // Present when the event originates from the backend (e.g. MA's sevt_...).
    // Unique per task so the poller is idempotent across ticks.
    sourceEventId: text('source_event_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('ledger_mission_created_idx').on(t.missionId, t.createdAt),
    index('ledger_task_created_idx').on(t.taskId, t.createdAt),
    index('ledger_event_type_idx').on(t.eventType),
    uniqueIndex('ledger_task_source_event_unique_idx').on(t.taskId, t.sourceEventId),
  ],
);

// ── Skills ──────────────────────────────────────────────────────────

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  version: text('version').notNull().default('1.0.0'),
  description: text('description'),
  /** Raw SKILL.md content — the declarative playbook. */
  promptTemplate: text('prompt_template').notNull(),
  /** Optional JSON list of allowed tool names. Narrows the agent toolset. */
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[]>(),
  /** If uploaded to MA Skills API, the remote skill_id for caching. */
  remoteSkillId: text('remote_skill_id'),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

// ── Retrospectives ──────────────────────────────────────────────────

export const retrospectiveStatus = ['pending', 'running', 'completed', 'failed'] as const;
export type RetrospectiveStatus = (typeof retrospectiveStatus)[number];

export const proposalType = ['skill_diff', 'memory_entry'] as const;
export type ProposalType = (typeof proposalType)[number];

export const proposalStatus = ['pending', 'accepted', 'rejected', 'edited'] as const;
export type ProposalStatus = (typeof proposalStatus)[number];

export const retrospectives = sqliteTable('retrospectives', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' }),
  status: text('status', { enum: retrospectiveStatus }).notNull().default('pending'),
  sessionId: text('session_id'),
  /** Raw analysis output from the retrospective agent. */
  analysis: text('analysis'),
  requestedBy: text('requested_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const retrospectiveProposals = sqliteTable(
  'retrospective_proposals',
  {
    id: text('id').primaryKey(),
    retrospectiveId: text('retrospective_id')
      .notNull()
      .references(() => retrospectives.id, { onDelete: 'cascade' }),
    type: text('type', { enum: proposalType }).notNull(),
    status: text('status', { enum: proposalStatus }).notNull().default('pending'),
    /** JSON content — shape depends on type. */
    content: text('content', { mode: 'json' }).$type<ProposalContent>(),
    /** Ledger event IDs that support this proposal. */
    evidenceEventIds: text('evidence_event_ids', { mode: 'json' }).$type<string[]>(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('proposals_retro_idx').on(t.retrospectiveId),
    index('proposals_status_idx').on(t.status),
  ],
);

export type SkillDiffContent = {
  skillSlug: string;
  diff: string;
  rationale: string;
};

export type MemoryEntryContent = {
  scope: string;
  scopeKey: string;
  key: string;
  value: string;
  confidence: number;
  rationale: string;
};

export type ProposalContent = SkillDiffContent | MemoryEntryContent;

export type Retrospective = typeof retrospectives.$inferSelect;
export type NewRetrospective = typeof retrospectives.$inferInsert;
export type RetrospectiveProposal = typeof retrospectiveProposals.$inferSelect;

// ── Memory ──────────────────────────────────────────────────────────

export const memoryScope = ['repo', 'backend', 'global'] as const;
export type MemoryScope = (typeof memoryScope)[number];

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: memoryScope }).notNull(),
    /** e.g. "acme/api" for repo scope, "managed-agents" for backend, "_" for global */
    scopeKey: text('scope_key').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** 0.0–1.0 confidence score. Incremented on successful use, decremented on failures. */
    confidence: integer('confidence').notNull().default(50), // stored as 0-100 integer
    /** Where this memory came from. */
    sourceType: text('source_type'), // 'retrospective' | 'manual'
    sourceId: text('source_id'), // retrospective proposal ID or null
    learnedAt: integer('learned_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('memories_scope_idx').on(t.scope, t.scopeKey),
    index('memories_key_idx').on(t.key),
    index('memories_expires_idx').on(t.expiresAt),
  ],
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export type AutoMergePolicy = {
  enabled: boolean;
  maxAdditions?: number;
  maxDeletions?: number;
  maxFilesChanged?: number;
  requiredChecks?: string[];
  allowedPathPatterns?: string[];
};

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert;

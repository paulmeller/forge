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

export const backend = ['managed-agents', 'gateway', 'gemini-managed-agents'] as const;
export type Backend = (typeof backend)[number];

export const plannerStrategy = ['rule-based', 'llm', 'graph', 'triage'] as const;
export type PlannerStrategy = (typeof plannerStrategy)[number];

/**
 * Discriminates a Task's role in a multi-stage pipeline. `standard` is the
 * default single-shot Task (open a PR, gate on CI). The triage planner emits
 * `reproduce` → `fix` pairs: a `reproduce` Task confirms the bug and records a
 * verdict but opens no PR; a `fix` Task depends on it and only runs when the
 * verdict says the bug reproduced.
 */
export const taskKind = ['standard', 'reproduce', 'fix'] as const;
export type TaskKind = (typeof taskKind)[number];

/**
 * The structured outcome of a `reproduce` Task. The bug-reproduce skill
 * instructs the agent to end its turn by emitting this shape; the reconciler
 * lifts it onto the Task and the dispatcher gates the dependent `fix` Task on
 * `reproduced`.
 */
export type ReproduceVerdict = {
  reproduced: boolean;
  summary: string;
  /** Versions the bug was confirmed present / absent on, e.g. { 'v5.0': true, 'v6.0': false }. */
  affectedVersions?: Record<string, boolean>;
  /** Free-form evidence pointer (failing test name, stack excerpt, repro steps). */
  evidence?: string;
  /** Branch the reproduce agent pushed a failing regression test to, for the fix stage to build on. */
  branch?: string;
};

export const taskStatus = [
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'ready_to_merge',
  'needs_human',
  'merging',
  'merged',
  'resolved',
  'abandoned',
  'failed',
] as const;
export type TaskStatus = (typeof taskStatus)[number];

export const haltReason = [
  'max_turns',
  'task_token_cap',
  'no_progress',
  'budget_hard_stop',
  'manual_abort',
] as const;
export type HaltReason = (typeof haltReason)[number];

/**
 * Why a Task landed in `needs_human`. Diagnostic only — the gate is the
 * status. Auto-merge must never key on this column.
 */
export const escalationReason = [
  'ai_review_rejected',
  'verify_incomplete',
  'gate_stall',
  'auto_merge_failed',
  'merge_stall',
] as const;
export type EscalationReason = (typeof escalationReason)[number];

/**
 * A human's decision on the PR, mirrored from GitHub review events.
 *
 * KNOWN LIMITATION: this column is a single scalar reflecting the *most
 * recent* `pull_request_review` event, not an aggregate of the PR's
 * reviews. Dismissing one review nulls it out even when a different
 * reviewer's approval is still standing on GitHub — the webhook handler
 * has no view of the PR's other reviews, and correcting that would need
 * either a live GitHub API call or a per-reviewer schema, both out of
 * scope for now. Nothing currently gates a merge decision on this field;
 * do not start trusting it for that without fixing the aggregation gap
 * first.
 */
export const reviewDecision = ['approved', 'changes_requested', 'commented'] as const;
export type ReviewDecision = (typeof reviewDecision)[number];

/** Loop policy carried by a skill (authored in SKILL.md frontmatter). */
export type LoopPolicy = {
  maxTurns?: number;
  maxTokens?: number;
  noProgressTokens?: number;
  selfVerify?: boolean;
  verifyModel?: string;
  acceptanceCriteria?: string;
};

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
  /**
   * GitHub issue-search query for the `triage` planner, e.g.
   * `repo:vercel/ai is:issue is:open label:bug`. One reproduce→fix Task pair is
   * emitted per matching issue. Null for non-triage strategies.
   */
  issueQuery: text('issue_query'),
  /**
   * Set for any repo-scoped Mission (both the repo's container and its
   * issue leaves — see `issueRef`/`parentMissionId` below for which is
   * which). Null for ordinary composer-authored campaign missions.
   */
  workspaceRepo: text('workspace_repo'),
  /**
   * Set only on an issue leaf Mission (format "owner/repo#123", matching
   * `tasks.issueRef`) — the specific issue this Mission's tasks belong to.
   * Null on the repo's container Mission and on campaigns.
   */
  issueRef: text('issue_ref'),
  /**
   * Self-referential: set on an issue leaf Mission, pointing at its repo's
   * container. Null on containers and on campaigns (both are always
   * roots). A container has `workspaceRepo` set, `issueRef` null, and
   * `parentMissionId` null, owns zero tasks, and must never appear as a
   * row anywhere — see mission-shape.ts (Phase 2) and listMissions()
   * (Task 4 of this plan).
   */
  parentMissionId: text('parent_mission_id'),
  /**
   * Issue refs ("owner/repo#123") a human has marked "Next" on this
   * repo's container — queued-for-work without dispatching. Cleared for
   * an issueRef the moment `workOnIssue` is called for it. Null/empty for
   * everything except containers actually in use.
   */
  nextIssueRefs: text('next_issue_refs', { mode: 'json' }).$type<string[]>(),
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
  // Loop guardrails — per-task limit overrides (null → fall back to skill policy → env).
  budgetHardStopPct: integer('budget_hard_stop_pct').notNull().default(100),
  taskMaxTokens: integer('task_max_tokens'),
  taskMaxTurns: integer('task_max_turns'),
  noProgressTokens: integer('no_progress_tokens'),
  selfVerifyEnabled: integer('self_verify_enabled', { mode: 'boolean' }).notNull().default(false),
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
    /** Pipeline role — `standard` (open a PR) vs. triage `reproduce` / `fix`. */
    kind: text('kind', { enum: taskKind }).notNull().default('standard'),
    /** Reproduce Task outcome (present once a `reproduce` Task reaches `resolved`). */
    verdict: text('verdict', { mode: 'json' }).$type<ReproduceVerdict>(),
    dependsOnIds: text('depends_on_ids', { mode: 'json' }).$type<string[]>(),
    status: text('status', { enum: taskStatus }).notNull().default('queued'),
    sessionId: text('session_id'),
    // The backend's *live* session handle. Usually identical to sessionId, but
    // Gemini rotates its interaction id on every turn, so this tracks which
    // physical handle is currently live. Persisted because the tick engine runs
    // on Cloud Run with --min-instances=0: in-memory adapter state does not
    // survive a cold start or a scale-out to another instance, and a stale
    // handle makes cancelSession silently cancel an already-finished session.
    // Nullable only for tasks created before this column existed.
    backendSessionRef: text('backend_session_ref'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    diffAdditions: integer('diff_additions'),
    diffDeletions: integer('diff_deletions'),
    filesChanged: integer('files_changed'),
    retryCount: integer('retry_count').notNull().default(0),
    aiReviewRetryCount: integer('ai_review_retry_count').notNull().default(0),
    // Loop guardrails — turn/progress tracking + verify gate state.
    turnCount: integer('turn_count').notNull().default(0),
    lastProgressAt: integer('last_progress_at', { mode: 'timestamp_ms' }),
    costTokensAtProgress: integer('cost_tokens_at_progress').notNull().default(0),
    verifyRetryCount: integer('verify_retry_count').notNull().default(0),
    lastVerifiedSha: text('last_verified_sha'),
    haltReason: text('halt_reason', { enum: haltReason }),
    escalationReason: text('escalation_reason', { enum: escalationReason }),
    // See the KNOWN LIMITATION comment on the `reviewDecision` export above:
    // this reflects only the most recent review event, not an aggregate.
    reviewDecision: text('review_decision', { enum: reviewDecision }),
    approvedBy: text('approved_by'),
    // The PR head SHA at the moment `approvedBy` was set (review-actions.ts's
    // Approve action). Follows the same precedent as `lastVerifiedSha` above:
    // an approval is a statement about a specific diff, and a bare user id
    // cannot express that. auto-merge.ts's `requireHumanApproval` gate
    // compares this against the PR's *current* head SHA before honouring the
    // approval — see the AutoMergePolicy.requireHumanApproval doc comment
    // below for the full invariant.
    approvedHeadSha: text('approved_head_sha'),
    acceptanceCriteria: text('acceptance_criteria'),
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
    // Deliberately non-unique: the GitHub webhook looks up a Task by
    // `pr_url` on every delivery, so this lookup wants an index regardless,
    // but a legitimate future case (a retried task reopening against the
    // same PR) must not blow up on an insert. See taskByPrUrl in
    // apps/web's github/webhook route for the tie-break this backs.
    index('tasks_pr_url_idx').on(t.prUrl),
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
  /** Loop bounds + acceptance criteria, authored in SKILL.md frontmatter. */
  loopPolicy: text('loop_policy', { mode: 'json' }).$type<LoopPolicy>(),
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

// ── GitHub Installations ────────────────────────────────────────────

export const githubInstallations = sqliteTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    installationId: integer('installation_id').notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(), // 'Organization' | 'User'
    agentId: text('agent_id'), // per-user agent override, falls back to env default
    githubVaultId: text('github_vault_id'), // per-user vault override
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('gh_install_user_idx').on(t.userId),
    uniqueIndex('gh_install_unique').on(t.installationId),
  ],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;

export const githubInstallationRepos = sqliteTable(
  'github_installation_repos',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id')
      .notNull()
      .references(() => githubInstallations.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(), // 'owner/repo'
    /**
     * Per-repo policy. JSON rather than one column per setting so later
     * settings do not each need a migration, and so this can later be
     * sourced from versioned config when policy-as-code lands.
     */
    repoPolicy: text('repo_policy', { mode: 'json' }).$type<RepoPolicy>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('gh_repo_unique').on(t.installationId, t.repo),
    index('gh_repo_lookup_idx').on(t.repo),
  ],
);

export type GithubInstallationRepo = typeof githubInstallationRepos.$inferSelect;

export type RepoPolicy = {
  requirePlanApproval: boolean;
};

export type AutoMergePolicy = {
  enabled: boolean;
  maxAdditions?: number;
  maxDeletions?: number;
  maxFilesChanged?: number;
  requiredChecks?: string[];
  allowedPathPatterns?: string[];
  /**
   * When true, only Tasks with `task.approvedBy` set are merge-eligible.
   *
   * `approvedBy` is written by the review Approve action
   * (review-actions.ts) when a human clicks Approve on a `needs_human`
   * Task, and read by auto-merge.ts's `requireHumanApproval` gate above.
   *
   * This is a "a human looked" control, not separation of duties: nothing
   * stops the Mission owner from approving their own Task, and there is no
   * plan to add that check. Operators must not read this as a four-eyes /
   * dual-control guarantee.
   *
   * An approval IS scoped to the reviewed diff, not to the Task id forever
   * — that is enforced by `approvedHeadSha` (schema.ts, set alongside
   * `approvedBy`), which records the PR's head SHA at the moment of
   * approval. auto-merge.ts's `tryMerge` re-reads the PR's *current* head
   * SHA and refuses to honour the approval if it no longer matches —
   * closing the gap where a force-push after Approve (a different diff)
   * would otherwise sail through on the strength of an approval that was
   * never about that diff. `approvedHeadSha` is not independently cleared
   * everywhere `approvedBy` is (see below); it only needs to agree with
   * `approvedBy`'s lifecycle where both are read together, which is only
   * inside `tryMerge`, and `tryMerge` is only ever reached there when
   * `approvedBy` is already known non-null (runAutoMerge filters out
   * `!approvedBy` candidates first) — so a stale `approvedHeadSha` left
   * behind after `approvedBy` clears to null is inert data, never read.
   *
   * The invariant: a Task that is not `needs_human` or `ready_to_merge` must
   * never carry a non-null `approvedBy` — approving applies to work
   * awaiting or cleared for merge, nothing else. It is cleared everywhere
   * the Task either abandons that diff or gets re-escalated to a human for
   * a *different* one to look at:
   *   - Dismiss (review-actions.ts) — the diff was rejected outright.
   *   - Auto-merge rollback (auto-merge.ts) — the merge attempt failed.
   *   - The merging-sweep closed-unmerged branch (reconciler.ts) and its
   *     fast-path webhook twin (github/webhook/route.ts) — the PR closed
   *     without merging while auto-merge was armed.
   *   - The gate-stall sweep (reconciler.ts) — the Task wedged and needs a
   *     human to look again.
   *   - Verify escalation (verify.ts) and AI-review escalation
   *     (ai-review.ts) — a fresh escalation to a human supersedes whatever
   *     an earlier approval covered.
   *   - retryMission (mission-transitions.ts) — a retry produces new work
   *     (a different diff, a different PR), so nothing about the old
   *     approval applies to it.
   *   - The budget hard-stop (budgets.ts) — a mission-level stop can force
   *     a `ready_to_merge`/`needs_human`/`merging` Task straight to
   *     `failed`.
   *   - Manual abort (repos/[owner]/[repo]/actions.ts) — an operator can
   *     abort any Task with a live session, including one already approved.
   *   - The webhook's generic closed-unmerged branch
   *     (github/webhook/route.ts) — a PR can close while its Task is still
   *     `ready_to_merge`, before auto-merge or the reconciler sweep acts.
   * Defaults false: unattended auto-merge stays a real feature, but
   * operators who want Renovate-style approval can opt in.
   */
  requireHumanApproval?: boolean;
};

export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert;

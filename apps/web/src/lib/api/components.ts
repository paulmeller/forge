import {
  backend,
  escalationReason,
  haltReason,
  missionStatus,
  plannerStrategy,
  reviewDecision,
  taskKind,
  taskStatus,
} from '@forge/db';

import { apiErrorCodes } from './errors';
import { missionResponseFields, taskResponseFields } from './dto';

/**
 * The OpenAPI `components.schemas` entries for the DB-row responses, plus the
 * per-operation response bodies that reference them.
 *
 * Why hand-written rather than derived from Zod like the request schemas:
 * these responses are Drizzle rows, and there is no Zod schema in the system
 * that describes one. Inventing one purely to feed z.toJSONSchema would add a
 * second declaration of the same shape and a second thing to keep in step.
 *
 * Drift is prevented structurally instead. `missionProperties` is typed
 * `Record<(typeof missionResponseFields)[number], JsonSchema>` — the same
 * array lib/api/dto.ts builds the response from — so the compiler REQUIRES a
 * documented property for every field the API publishes and REJECTS one for
 * a field it withholds. Documenting `webhookSecret` here would not compile;
 * neither would forgetting to document a field added to the DTO.
 */

type JsonSchema = Record<string, unknown>;

/** A nullable column: OpenAPI 3.1 uses a type union, not `nullable: true`. */
const nullable = (schema: JsonSchema): JsonSchema => {
  const type = schema.type;
  return { ...schema, type: Array.isArray(type) ? [...type, 'null'] : [type, 'null'] };
};

const str: JsonSchema = { type: 'string' };
const int: JsonSchema = { type: 'integer' };
const bool: JsonSchema = { type: 'boolean' };
const timestamp: JsonSchema = { type: 'string', format: 'date-time' };
const obj: JsonSchema = { type: 'object', additionalProperties: true };
const strArray: JsonSchema = { type: 'array', items: { type: 'string' } };
const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });

const missionProperties: Record<(typeof missionResponseFields)[number], JsonSchema> = {
  id: str,
  userId: str,
  name: str,
  goal: str,
  status: enumOf(missionStatus),
  backend: enumOf(backend),
  agentId: str,
  plannerStrategy: enumOf(plannerStrategy),
  targetRepos: nullable(strArray),
  issueQuery: nullable(str),
  workspaceRepo: nullable(str),
  issueRef: nullable(str),
  parentMissionId: nullable(str),
  nextIssueRefs: nullable(strArray),
  concurrencyCap: int,
  budgetUsd: nullable(int),
  budgetTokens: nullable(int),
  budgetThresholdPct: int,
  budgetHardStopPct: int,
  spentUsd: int,
  spentTokens: int,
  autoMergePolicy: nullable(obj),
  githubInstallationId: nullable(str),
  githubVaultId: nullable(str),
  skillId: nullable(str),
  aiReviewEnabled: bool,
  selfVerifyEnabled: bool,
  taskMaxTokens: nullable(int),
  taskMaxTurns: nullable(int),
  noProgressTokens: nullable(int),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: nullable(timestamp),
  completedAt: nullable(timestamp),
};

const taskProperties: Record<(typeof taskResponseFields)[number], JsonSchema> = {
  id: str,
  missionId: str,
  repo: str,
  baseBranch: str,
  promptVars: nullable(obj),
  issueRef: nullable(str),
  kind: enumOf(taskKind),
  verdict: nullable(obj),
  dependsOnIds: nullable(strArray),
  status: enumOf(taskStatus),
  sessionId: nullable(str),
  backendSessionRef: nullable(str),
  prUrl: nullable(str),
  prNumber: nullable(int),
  diffAdditions: nullable(int),
  diffDeletions: nullable(int),
  filesChanged: nullable(int),
  retryCount: int,
  aiReviewRetryCount: int,
  turnCount: int,
  lastProgressAt: nullable(timestamp),
  costTokensAtProgress: int,
  verifyRetryCount: int,
  lastVerifiedSha: nullable(str),
  haltReason: nullable(enumOf(haltReason)),
  escalationReason: nullable(enumOf(escalationReason)),
  reviewDecision: nullable(enumOf(reviewDecision)),
  approvedBy: nullable(str),
  approvedHeadSha: nullable(str),
  acceptanceCriteria: nullable(str),
  lastError: nullable(str),
  costUsd: int,
  costTokens: int,
  createdAt: timestamp,
  updatedAt: timestamp,
  dispatchedAt: nullable(timestamp),
  completedAt: nullable(timestamp),
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** `{ mission: Mission }` and friends — the envelope from respond.ts. */
const envelope = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
});

const collection = (name: string): JsonSchema => ({ type: 'array', items: ref(name) });

export const componentSchemas: Record<string, JsonSchema> = {
  Mission: {
    type: 'object',
    description:
      "A Mission as /api/v1 publishes it. Deliberately not every column of the " +
      "`missions` table: `webhookSecret` (the mission's inbound-callback HMAC " +
      'key) is withheld — see lib/api/dto.ts.',
    properties: missionProperties,
    required: [...missionResponseFields],
  },
  Task: {
    type: 'object',
    description: 'A Task as /api/v1 publishes it.',
    properties: taskProperties,
    required: [...taskResponseFields],
  },
  LedgerEvent: {
    type: 'object',
    description: "One append-only audit row from a Mission's or Task's ledger.",
    properties: {
      id: str,
      missionId: str,
      taskId: nullable(str),
      eventType: str,
      payload: nullable(obj),
      sourceEventId: nullable(str),
      createdAt: timestamp,
    },
    required: ['id', 'missionId', 'taskId', 'eventType', 'payload', 'sourceEventId', 'createdAt'],
  },
  RepoPolicy: {
    type: 'object',
    description:
      'Per-repo policy. Fails closed: anything other than an explicit false ' +
      'reads as requirePlanApproval true.',
    properties: { requirePlanApproval: bool },
    required: ['requirePlanApproval'],
  },
  Error: {
    type: 'object',
    description:
      'Fixed error envelope used by every v1 route. Trade-off: collapses ' +
      'multi-field Zod validation failures into one joined message ' +
      'string, rather than the per-field issue array the deleted ' +
      'POST /api/missions used to return.',
    properties: {
      error: {
        type: 'object',
        properties: {
          // Generated from apiErrorCodes (lib/api/errors.ts) — the same array
          // `fail()` is typed against, so the enum cannot list a code no
          // route can emit, nor omit one that a route can. A CLI reads this
          // instead of grepping route handlers to learn that "not found" is
          // one string and not three.
          code: { type: 'string', enum: [...apiErrorCodes] },
          message: str,
        },
        required: ['code', 'message'],
      },
    },
    required: ['error'],
  },
};

/**
 * Success body per operation id, keyed exactly like lib/api/schemas.ts.
 *
 * openapi.test.ts asserts these keys cover every route-bearing entry of that
 * registry, so a new endpoint cannot ship documenting only its request. That
 * was the old failure mode: every operation declared
 * `responses: {"200": {description: "Success"}}` with no schema at all, so a
 * generated client knew how to call the API and nothing about what came back.
 */
export const responseSchemas: Record<string, JsonSchema> = {
  'missions.list': envelope({ missions: collection('Mission') }),
  'missions.create': envelope({ mission: ref('Mission') }),
  'missions.get': envelope({ mission: ref('Mission') }),
  'missions.plan': envelope({
    mission: ref('Mission'),
    taskCount: int,
    // Always present (null when the Planner dropped nothing) so a caller can
    // read one field unconditionally — see PlanResult in lib/planner.ts.
    skipped: {
      type: ['object', 'null'],
      properties: { issueCount: int, repos: strArray },
      required: ['issueCount', 'repos'],
    },
  }),
  'missions.start': envelope({ mission: ref('Mission') }),
  'missions.cancel': envelope({ mission: ref('Mission') }),
  'missions.retry': envelope({ mission: ref('Mission'), retriedCount: int }),
  'tasks.list': envelope({ tasks: collection('Task') }),
  'tasks.get': envelope({ task: ref('Task') }),
  'tasks.approve': envelope({ task: ref('Task') }),
  'tasks.dismiss': envelope({ task: ref('Task') }),
  'tasks.steer': envelope({ task: ref('Task') }),
  'tasks.abort': envelope({ task: ref('Task') }),
  'ledger.mission': envelope({ events: collection('LedgerEvent') }),
  'ledger.task': envelope({ events: collection('LedgerEvent') }),
  'repos.list': envelope({ repos: strArray }),
  'repos.getPolicy': envelope({ policy: ref('RepoPolicy') }),
  'repos.setPolicy': envelope({ policy: ref('RepoPolicy') }),
};

/**
 * Both credentials lib/api-auth.ts accepts, described so a client generator
 * emits an authenticated client rather than an anonymous one.
 *
 * The spec previously had NO securitySchemes and no security block at all —
 * the bearer / x-api-key credential that is the entire point of this surface
 * was undocumented. Applied at the document level (see buildOpenApiDocument),
 * as a list of two alternatives, which is OpenAPI's OR: either satisfies
 * every operation, matching withBearerAlias's behaviour of treating
 * `x-api-key` as an alias for `Authorization: Bearer`.
 */
export const securitySchemes: Record<string, JsonSchema> = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    description:
      'A better-auth session token: `Authorization: Bearer <token>`. Wins ' +
      'over x-api-key when both are present.',
  },
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description:
      'The same token in the sibling engine\'s header convention, so one CLI ' +
      'can speak to both products. Treated as an alias for the bearer token.',
  },
};

/** Document-level `security`: either scheme alone satisfies any operation. */
export const documentSecurity = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

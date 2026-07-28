import { z } from 'zod';
import { missionStatus } from '@forge/db';
import { createMissionSchema } from '@/lib/missions';

export const schemas = {
  'missions.list': {
    method: 'GET',
    path: '/api/v1/missions',
    query: z.object({ status: z.enum(missionStatus).optional() }),
  },
  'missions.create': { method: 'POST', path: '/api/v1/missions', body: createMissionSchema },
  'missions.get': {
    method: 'GET',
    path: '/api/v1/missions/{missionId}',
    params: z.object({ missionId: z.string() }),
  },
  'missions.plan': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/plan',
    params: z.object({ missionId: z.string() }),
  },
  'missions.start': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/start',
    params: z.object({ missionId: z.string() }),
  },
  'missions.cancel': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/cancel',
    params: z.object({ missionId: z.string() }),
  },
  'missions.retry': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/retry',
    params: z.object({ missionId: z.string() }),
  },
  'tasks.list': {
    method: 'GET',
    path: '/api/v1/missions/{missionId}/tasks',
    params: z.object({ missionId: z.string() }),
  },
  'tasks.get': {
    method: 'GET',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
  },
  'tasks.approve': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}/approve',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
  },
  'tasks.dismiss': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}/dismiss',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
  },
  'tasks.steer': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}/steer',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
    // .trim() so a whitespace-only message fails the SAME check
    // (too_small/min(1)) as an empty string does, at the SAME status (400).
    // Without it, '   ' passed min(1) here, then task-session-ops.ts's own
    // trim rejected it as 'Message is empty' — a 409 for a semantically
    // identical input. The lib keeps its own trim()+empty check too (belt
    // and braces, and the only enforcement the Server Action transport
    // gets), but this is what makes the two transports agree on 400.
    body: z.object({ message: z.string().trim().min(1).max(10_000) }),
  },
  'tasks.abort': {
    method: 'POST',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}/abort',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
  },
  'ledger.mission': {
    method: 'GET',
    path: '/api/v1/missions/{missionId}/ledger',
    params: z.object({ missionId: z.string() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
  },
  'ledger.task': {
    method: 'GET',
    path: '/api/v1/missions/{missionId}/tasks/{taskId}/ledger',
    params: z.object({ missionId: z.string(), taskId: z.string() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
  },
  'repos.list': { method: 'GET', path: '/api/v1/repos' },
  'repos.getPolicy': {
    method: 'GET',
    path: '/api/v1/repos/{owner}/{repo}/policy',
    params: z.object({ owner: z.string(), repo: z.string() }),
  },
  // Deliberately narrower than the interactive Settings page's
  // updateRepoSettings (settings-actions.ts), which also sets
  // concurrencyCap/budgetUsd/aiReviewEnabled/selfVerifyEnabled/autoMerge on
  // the container mission itself. Those live on a Mission row that a v1
  // caller has no id for (the route's only handle is {owner}/{repo}), and
  // are a separate concern from the plan-approval gate this endpoint's name
  // is about. requirePlanApproval is the one field that lives on the repo's
  // github_installation_repos row rather than a mission, so it's the one
  // this route can set without inventing a way to address a container by
  // repo path for fields that aren't about "policy" at all. Narrower is fine
  // here — advertising a field the route ignores would not be.
  'repos.setPolicy': {
    method: 'PUT',
    path: '/api/v1/repos/{owner}/{repo}/policy',
    params: z.object({ owner: z.string(), repo: z.string() }),
    body: z.object({ requirePlanApproval: z.boolean() }),
  },
} as const;

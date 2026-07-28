import { z } from 'zod';
import { missionStatus } from '@forge/db';
import { createMissionSchema } from '@/lib/missions';

export const schemas = {
  'missions.list': { query: z.object({ status: z.enum(missionStatus).optional() }) },
  'missions.create': { body: createMissionSchema },
  'missions.get': { params: z.object({ missionId: z.string() }) },
  'missions.plan': { params: z.object({ missionId: z.string() }) },
  'missions.start': { params: z.object({ missionId: z.string() }) },
  'missions.cancel': { params: z.object({ missionId: z.string() }) },
  'missions.retry': { params: z.object({ missionId: z.string() }) },
  'tasks.list': { params: z.object({ missionId: z.string() }) },
  'tasks.get': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.approve': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.dismiss': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'tasks.steer': {
    params: z.object({ missionId: z.string(), taskId: z.string() }),
    body: z.object({ message: z.string().min(1).max(10_000) }),
  },
  'tasks.abort': { params: z.object({ missionId: z.string(), taskId: z.string() }) },
  'ledger.mission': { params: z.object({ missionId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  'ledger.task': { params: z.object({ missionId: z.string(), taskId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  'repos.list': {},
  'repos.getPolicy': { params: z.object({ repo: z.string() }) },
  'repos.setPolicy': {
    params: z.object({ repo: z.string() }),
    body: z.object({ requirePlanApproval: z.boolean() }),
  },
} as const;

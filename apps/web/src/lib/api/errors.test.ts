import { describe, expect, it } from 'vitest';

import { MissionTransitionError } from '@/lib/mission-transitions';
import { PlannerError } from '@/lib/planner';

import { apiErrorCodes, missionTransitionFailure, plannerFailure } from './errors';

describe('the closed api error-code set', () => {
  it('is exactly the six codes the OpenAPI Error schema enumerates', () => {
    expect([...apiErrorCodes]).toEqual([
      'invalid_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'invalid_state',
      'bad_gateway',
    ]);
  });

  // The point of the mapping: an internal code must never appear verbatim on
  // the wire. Anything not in the closed set is a third vocabulary returning.
  it('maps every MissionTransitionError code into the set', () => {
    for (const code of ['NOT_FOUND', 'WRONG_STATUS'] as const) {
      const mapped = missionTransitionFailure(new MissionTransitionError('boom', code));
      expect(apiErrorCodes).toContain(mapped.code);
      expect(mapped.code).not.toBe(code);
    }
  });

  it('maps every PlannerError code into the set', () => {
    for (const code of [
      'MISSION_NOT_FOUND',
      'WRONG_STATUS',
      'NO_TARGET_REPOS',
      'ALREADY_PLANNED',
    ] as const) {
      const mapped = plannerFailure(new PlannerError('boom', code));
      expect(apiErrorCodes).toContain(mapped.code);
      expect(mapped.code).not.toBe(code);
    }
  });
});

describe('missionTransitionFailure', () => {
  it('sends NOT_FOUND to not_found/404 and WRONG_STATUS to invalid_state/409', () => {
    expect(missionTransitionFailure(new MissionTransitionError('gone', 'NOT_FOUND'))).toEqual({
      code: 'not_found',
      message: 'gone',
      status: 404,
    });
    expect(
      missionTransitionFailure(new MissionTransitionError('expected draft, got running', 'WRONG_STATUS')),
    ).toEqual({ code: 'invalid_state', message: 'expected draft, got running', status: 409 });
  });
});

describe('plannerFailure', () => {
  it('sends MISSION_NOT_FOUND to not_found/404', () => {
    expect(plannerFailure(new PlannerError('mission not found', 'MISSION_NOT_FOUND'))).toEqual({
      code: 'not_found',
      message: 'mission not found',
      status: 404,
    });
  });

  // Three distinct planner causes collapse onto one transport code. That is
  // deliberate — a CLI branches on the HTTP condition, not the internal
  // reason — but the reason must survive somewhere, so the domain message is
  // passed through byte-for-byte rather than replaced with a generic one.
  it('collapses the three conflict causes onto invalid_state/409, preserving each message verbatim', () => {
    const cases: [PlannerError['code'], string][] = [
      ['WRONG_STATUS', 'mission is running; planner only runs on draft'],
      ['NO_TARGET_REPOS', 'mission has no target repos'],
      ['ALREADY_PLANNED', 'mission is planning; planner only runs on draft'],
    ];
    for (const [code, message] of cases) {
      expect(plannerFailure(new PlannerError(message, code))).toEqual({
        code: 'invalid_state',
        message,
        status: 409,
      });
    }
  });
});

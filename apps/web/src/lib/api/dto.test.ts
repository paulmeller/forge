import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { missions, tasks, type Mission, type Task } from '@forge/db';

import {
  missionFieldsWithheld,
  missionResponseFields,
  taskFieldsWithheld,
  taskResponseFields,
  toMissionResponse,
  toTaskResponse,
} from './dto';

/**
 * The allow-list's one weakness is that a newly added column is silently
 * dropped from the API. These two tests remove it: every column of
 * `missions`/`tasks` must appear in exactly one of the two arrays, so adding
 * a column makes this file fail until someone writes down whether it is
 * published or withheld. Neither answer is assumed; only "nobody decided" is
 * rejected.
 */
describe('every DB column is an explicit publish-or-withhold decision', () => {
  it('accounts for every missions column', () => {
    const columns = Object.keys(getTableColumns(missions)).sort();
    const accounted = [...missionResponseFields, ...missionFieldsWithheld].sort();
    expect(accounted).toEqual(columns);
  });

  it('accounts for every tasks column', () => {
    const columns = Object.keys(getTableColumns(tasks)).sort();
    const accounted = [...taskResponseFields, ...taskFieldsWithheld].sort();
    expect(accounted).toEqual(columns);
  });
});

describe('toMissionResponse', () => {
  const row = {
    ...Object.fromEntries(Object.keys(getTableColumns(missions)).map((c) => [c, `val_${c}`])),
    webhookSecret: 'whsec_super_secret',
  } as unknown as Mission;

  it('omits webhookSecret', () => {
    expect(toMissionResponse(row)).not.toHaveProperty('webhookSecret');
  });

  // An allow-list is only an allow-list if unnamed keys cannot ride along.
  // A row carrying a column this file has never heard of (exactly what a
  // future migration produces) must not reach a caller.
  it('drops any key not named in missionResponseFields, including unknown ones', () => {
    const withFutureColumn = { ...row, someFutureSecret: 'oops' } as unknown as Mission;
    expect(Object.keys(toMissionResponse(withFutureColumn)).sort()).toEqual(
      [...missionResponseFields].sort(),
    );
  });

  it('passes through every field it does name', () => {
    const out = toMissionResponse(row) as Record<string, unknown>;
    for (const field of missionResponseFields) {
      expect(out[field]).toBe(`val_${field}`);
    }
  });
});

describe('toTaskResponse', () => {
  const row = Object.fromEntries(
    Object.keys(getTableColumns(tasks)).map((c) => [c, `val_${c}`]),
  ) as unknown as Task;

  it('drops any key not named in taskResponseFields, including unknown ones', () => {
    const withFutureColumn = { ...row, someFutureSecret: 'oops' } as unknown as Task;
    expect(Object.keys(toTaskResponse(withFutureColumn)).sort()).toEqual(
      [...taskResponseFields].sort(),
    );
  });

  it('passes through every field it does name', () => {
    const out = toTaskResponse(row) as Record<string, unknown>;
    for (const field of taskResponseFields) {
      expect(out[field]).toBe(`val_${field}`);
    }
  });
});

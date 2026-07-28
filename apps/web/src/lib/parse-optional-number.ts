/**
 * Number input → optional number. Returns undefined (not 0) for a blank
 * box, so an unset cap is stored as omitted: `maxAdditions: 0` would mean
 * "no diff may add a line" and block every merge, not "no cap".
 */
export function parseOptionalNumber(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

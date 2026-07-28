import { lte } from 'drizzle-orm';

import { deviceCode } from '@forge/db';

import { db } from '@/lib/db';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type DeviceCodeSweepResult = {
  deleted: number;
};

/**
 * Per-tick garbage collection for the device-authorization table.
 *
 * better-auth deletes a `deviceCode` row only when the CLI polls it after
 * expiry, polls it after a denial, or successfully exchanges it. Every other
 * row leaks: `/device/code` is unauthenticated, so anyone can create rows
 * indefinitely, and a CLI that is killed between requesting a code and polling
 * for it leaves one behind that nothing will ever look at again. An approved
 * code that is never exchanged leaks the same way.
 *
 * Expiry is the single condition — after `expiresAt` no row of any status can
 * still be used (`/device/token` refuses expired rows before it checks status),
 * so there is nothing left to preserve.
 *
 * `expiresAt` is stored as epoch milliseconds: better-auth hands the adapter a
 * `Date`, and libSQL writes `Date.valueOf()` into the integer column.
 */
export async function runDeviceCodeSweep(log: Logger): Promise<DeviceCodeSweepResult> {
  const deleted = await db
    .delete(deviceCode)
    .where(lte(deviceCode.expiresAt, Date.now()))
    .returning({ id: deviceCode.id });

  if (deleted.length > 0) {
    log.info({ count: deleted.length }, 'device_code:swept_expired');
  }

  return { deleted: deleted.length };
}

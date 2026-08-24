import { PrismaClient } from '@prisma/client';
import { currentActor } from './utils/actingUser.js';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}


/**
 * Record commercial changes to a garage — price, tier, access, trial dates — with who made them.
 *
 * A setting has "reverted" before with no way to tell whether a person did it or a bad write did.
 * This sits on the Prisma client rather than on the routes, so every path is covered, including
 * ones written later. Only the fields below are watched; everything else a garage update touches
 * is noise.
 */
const WATCHED_GARAGE_FIELDS = [
  'subscriptionCostGbp', 'messagingSubscriptionCostGbp', 'includedMinutes', 'costPerMinuteGbp',
  'includedMessages', 'costPerMessageGbp', 'vatRate',
  'hasVoiceAccess', 'hasMessagingAccess', 'accessRestricted',
  'trialEndDate', 'trialEndsAt', 'archivedAt', 'archiveScheduledAt',
  'twilioNumber', 'isTestAccount',
] as const;

prisma.$use(async (params, next) => {
  if (params.model !== 'Garage' || params.action !== 'update') return next(params);

  const data = (params.args?.data ?? {}) as Record<string, unknown>;
  const touched = WATCHED_GARAGE_FIELDS.filter((f) => f in data);
  if (!touched.length) return next(params);

  let before: Record<string, unknown> | null = null;
  try {
    before = (await prisma.garage.findUnique({
      where: params.args.where,
      select: Object.fromEntries(touched.map((f) => [f, true])),
    })) as Record<string, unknown> | null;
  } catch {
    before = null;    // never let the audit read block the write
  }

  const result = await next(params);

  try {
    const after = result as Record<string, unknown>;
    const same = (a: unknown, b: unknown) =>
      (a instanceof Date && b instanceof Date) ? a.getTime() === b.getTime() : a === b;
    const changes = touched
      .filter((f) => !same(before?.[f], after?.[f]))
      .map((f) => ({ field: f, from: before?.[f] ?? null, to: after?.[f] ?? null }));
    if (changes.length && after?.id) {
      const actor = currentActor();
      await prisma.agentConfigChange.create({
        data: {
          garageId: String(after.id),
          scope: 'garage',
          userId: actor?.userId ?? null,
          userEmail: actor?.email ?? null,
          changes: changes as unknown as object,
        },
      });
      console.log(`[GARAGE_AUDIT] ${actor?.email || 'system'} changed ${changes.map((c) => c.field).join(', ')} on ${after.name || after.id}`);
    }
  } catch (err) {
    // An audit failure must never undo a change that already succeeded.
    console.error('[GARAGE_AUDIT] could not record change:', err);
  }
  return result;
});

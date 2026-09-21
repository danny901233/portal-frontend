/**
 * Garage Hive reminder source — the one diary that can answer "who is due on this date?".
 *
 * Wraps the existing getReminderContacts, which already handles branch attribution for the
 * multi-branch companies (JDK, Eco, Great Hollands) where one Business Central company holds
 * several garages and a customer must only be messaged by the branch that actually serves them.
 *
 * Reads garageHiveBc.ts; modifies nothing.
 */

import { getReminderContacts, resolveCreds } from '../garageHiveBc.js';
import type { ReminderPull, ReminderSource } from './types.js';

export class GarageHiveReminderSource implements ReminderSource {
  readonly label = 'Garage Hive';
  readonly canPull = true;

  async dueContacts(garageId: string, daysAhead: number): Promise<ReminderPull> {
    const creds = await resolveCreds(garageId);
    if (!creds) throw new Error('No Garage Hive credentials resolved');
    return getReminderContacts(creds, daysAhead);
  }
}

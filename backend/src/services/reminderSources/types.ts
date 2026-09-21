/**
 * Where a reminder run gets "who is due" from.
 *
 * This is the ONLY part of reminders that differs by diary. Everything after it — deduping,
 * building the campaign, staging at 30/14/3 days, the send window and daily cap, delivery
 * tracking — is already diary-agnostic and lives in reminderScheduler.ts / outboundSend.ts.
 *
 * The interface is deliberately one method. An earlier sketch mirrored the chat and voice
 * adapters with a method per operation, which would have been four near-empty classes: of the
 * four diaries, only Garage Hive can enumerate vehicles due on a date. Poole and Bookar expose
 * MOT dates only for a registration you already name, and Tyresoft is a tyre supplier with no
 * diary of its own. Garages on those diaries source reminders by uploading their DMS export,
 * which needs no adapter because it is already the generic path.
 *
 * So: `canPull` is a real property of the diary, not a config flag, and a source that cannot
 * pull is not a failure to report — it is a garage whose contacts arrive by upload instead.
 */

import type { ReminderContact } from '../garageHiveBc.js';

export type { ReminderContact };

export interface ReminderPull {
  contacts: ReminderContact[];
  /** Registrations deliberately not messaged, with the reason — a branch we cannot attribute
   *  the customer to, or no contact number. Reported, never silently dropped. */
  skipped: { reg: string; reason: string }[];
}

export interface ReminderSource {
  readonly label: string;
  /** Can this diary list who is due, or must contacts be uploaded? */
  readonly canPull: boolean;
  /** Vehicles falling due `daysAhead` days from now. Only meaningful when canPull. */
  dueContacts(garageId: string, daysAhead: number): Promise<ReminderPull>;
}

/** A garage whose diary cannot enumerate due vehicles. Uploads are its route in. */
export class UploadOnlySource implements ReminderSource {
  readonly canPull = false;
  constructor(readonly label: string) {}
  async dueContacts(): Promise<ReminderPull> {
    return { contacts: [], skipped: [] };
  }
}

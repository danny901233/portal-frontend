/**
 * Pick the reminder source for a garage, from the same signals chooseDiary uses for chat so a
 * garage cannot end up with its chat on one diary and its reminders on another.
 */

import { GarageHiveReminderSource } from './garageHive.js';
import { UploadOnlySource, type ReminderSource } from './types.js';

export * from './types.js';
export { GarageHiveReminderSource };

export interface ReminderGarage {
  agentScript?: string | null;
  integrationProvider?: string | null;
  config?: Record<string, any> | null;
}

export function reminderSourceFor(garage: ReminderGarage): ReminderSource {
  const script = String(garage.agentScript || '').toLowerCase();
  const provider = String(garage.integrationProvider || '').toLowerCase();
  const cfg = garage.config || {};

  if (script.includes('tyresoft') || provider === 'tyresoft' || cfg.tsApiKey) {
    return new UploadOnlySource('Tyresoft');
  }
  if (script.includes('bookar') || provider === 'bookar' || cfg.bookarClientId) {
    return new UploadOnlySource('Bookar');
  }
  if (script.includes('poole') || provider === 'poole'
      || (cfg.branchKey && cfg.tenant) || cfg.poole?.branchKey) {
    return new UploadOnlySource('Poole (AutoSage)');
  }
  return new GarageHiveReminderSource();
}

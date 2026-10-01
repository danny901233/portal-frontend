/**
 * Which of the integration-backed agent features a garage's diary can actually do.
 *
 * Two features here only work when something downstream can answer the lookup: caller recognition
 * needs a phone→customer search, advisory upsells need a vehicle health-check feed. Which agent
 * SCRIPT a garage runs used to be a good enough proxy, because each script was tied to one
 * integration. The unified agent broke that — its diary comes from `integrationProvider`, and the
 * adapters disagree with each other (Tyresoft can do neither, AutoSage can recognise a caller but
 * exposes no advisories).
 *
 * So the question is about the diary, not the script. This mirrors the capability flags the
 * adapters declare in the agents repo (`unified-agent/diaries/*.py`), which is what actually
 * gates the tool at call time:
 *
 *     if not (DIARY.capabilities.caller_recognition and WANT_CALLER_RECOGNITION): ...
 *
 * Keys are the portal's provider values. The agent normalises `garage_hive` → `garagehive` via
 * ALIASES in `diaries/__init__.py`; nothing here needs to.
 *
 * Keep this in step with those adapters, and with the copy the Booking tab uses to decide whether
 * to show each toggle (app/agent-setup/_components/BookingTab.tsx).
 */
export interface DiaryCapabilities {
  callerRecognition: boolean;
  advisoryUpsells: boolean;
}

const NO_CAPABILITIES: DiaryCapabilities = {
  callerRecognition: false,
  advisoryUpsells: false,
};

const BY_PROVIDER: Record<string, DiaryCapabilities> = {
  garage_hive: { callerRecognition: true, advisoryUpsells: true },
  bookar: { callerRecognition: true, advisoryUpsells: true },
  poole: { callerRecognition: true, advisoryUpsells: false }, // AutoSage exposes no advisories
  tyresoft: { callerRecognition: false, advisoryUpsells: false },
  none: { callerRecognition: false, advisoryUpsells: false },
};

/**
 * The single-diary agents predate `integrationProvider` meaning anything, and a few still carry a
 * stale or empty value, so their capabilities come from the script instead. Trusting the provider
 * column for these would silently switch off a feature a live garage is already using.
 */
const BY_SCRIPT: Record<string, DiaryCapabilities> = {
  'receptionmate-agent-v3': { callerRecognition: true, advisoryUpsells: true },
  'GarageHive-agent': { callerRecognition: true, advisoryUpsells: true },
  'bookar-agent': { callerRecognition: true, advisoryUpsells: true },
  'poole-agent': { callerRecognition: true, advisoryUpsells: false },
};

/**
 * What this garage's agent can do, from its script and diary. Unknown values are treated as
 * capable of nothing — a provider nobody has wired up must not be assumed to support a lookup.
 */
export function diaryCapabilities(
  agentScript?: string | null,
  integrationProvider?: string | null,
): DiaryCapabilities {
  const byScript = BY_SCRIPT[(agentScript || '').trim()];
  if (byScript) return byScript;
  if ((agentScript || '').trim() !== 'unified-agent') return NO_CAPABILITIES;
  return BY_PROVIDER[(integrationProvider || 'none').trim()] ?? NO_CAPABILITIES;
}

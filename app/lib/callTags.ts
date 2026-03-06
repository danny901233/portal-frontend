export const TRACKED_TAGS = [
  'update',
  'quote',
  'general enquiry',
  'internal',
  'complaint',
  'human request',
  'confirmed booking',
  'other',
] as const;

export const TAG_LABELS: Record<string, string> = {
  update: 'Update',
  quote: 'Quote',
  'general enquiry': 'General Enquiry',
  internal: 'Internal',
  complaint: 'Complaint',
  'human request': 'Human Request',
  'confirmed booking': 'Confirmed Booking',
  other: 'Other',
};

export const TAG_STYLES: Record<string, string> = {
  update: 'bg-gradient-to-r from-sky-400 via-sky-500 to-sky-600 text-white',
  quote: 'bg-gradient-to-r from-indigo-400 via-indigo-500 to-indigo-600 text-white',
  'general enquiry': 'bg-gradient-to-r from-violet-400 via-violet-500 to-violet-600 text-white',
  internal: 'bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 text-slate-900',
  complaint: 'bg-gradient-to-r from-rose-400 via-rose-500 to-rose-600 text-white',
  'human request': 'bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-600 text-white',
  'confirmed booking': 'bg-gradient-to-r from-green-500 via-green-600 to-green-700 text-white',
  other: 'bg-gradient-to-r from-slate-500 via-slate-600 to-slate-700 text-white',
};

export const TAG_COLORS: Record<string, string> = {
  update: '#38bdf8',
  quote: '#6366f1',
  'general enquiry': '#a855f7',
  internal: '#fbbf24',
  complaint: '#fb7185',
  'human request': '#34d399',
  'confirmed booking': '#22c55e',
  other: '#64748b',
};

export const DEFAULT_CALL_TAG = 'other';

export const normaliseCallTag = (raw?: string | null): string => {
  const cleaned = (raw ?? '').trim().toLowerCase();
  return cleaned || DEFAULT_CALL_TAG;
};

export const getCallTagLabel = (raw?: string | null): string => {
  const tag = normaliseCallTag(raw);
  return TAG_LABELS[tag] ?? tag.replace(/\b\w/g, (char) => char.toUpperCase());
};

export const getCallTagStyle = (raw?: string | null): string => {
  const tag = normaliseCallTag(raw);
  return TAG_STYLES[tag] ?? TAG_STYLES[DEFAULT_CALL_TAG];
};

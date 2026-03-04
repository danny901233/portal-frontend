export const FEEDBACK_OPTIONS = [
  { value: 'agent_no_pickup', label: 'Agent didn’t pick up the call' },
  { value: 'agent_interrupting', label: 'Agent kept interrupting' },
  { value: 'agent_slow', label: 'Agent response time was too slow' },
  { value: 'agent_off_topic', label: 'Agent went off topic or misunderstood context' },
  { value: 'diary_integration_failed', label: 'Diary integration didn’t work' },
  { value: 'agent_no_resolution', label: 'Agent was not able to resolve the caller’s query' },
  { value: 'other', label: 'Other' },
] as const;

export type FeedbackReasonValue = (typeof FEEDBACK_OPTIONS)[number]['value'];

const LABEL_BY_VALUE = FEEDBACK_OPTIONS.reduce<Record<string, string>>((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

export const getFeedbackReasonLabel = (value: string): string => {
  if (LABEL_BY_VALUE[value]) {
    return LABEL_BY_VALUE[value];
  }

  const cleaned = value.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) {
    return value;
  }

  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
};

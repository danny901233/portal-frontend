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

const LABEL_BY_VALUE_FR: Record<string, string> = {
  agent_no_pickup: 'L’agent n’a pas décroché',
  agent_interrupting: 'L’agent coupait la parole',
  agent_slow: 'Temps de réponse de l’agent trop lent',
  agent_off_topic: 'L’agent est sorti du sujet ou a mal compris le contexte',
  diary_integration_failed: 'L’intégration de l’agenda n’a pas fonctionné',
  agent_no_resolution: 'L’agent n’a pas pu résoudre la demande de l’appelant',
  other: 'Autre',
};

export const getFeedbackReasonLabel = (value: string, lang: 'en' | 'fr' = 'en'): string => {
  const labels = lang === 'fr' ? LABEL_BY_VALUE_FR : LABEL_BY_VALUE;
  if (labels[value]) {
    return labels[value];
  }

  const cleaned = value.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) {
    return value;
  }

  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
};

export const getFeedbackOptions = (lang: 'en' | 'fr' = 'en') =>
  FEEDBACK_OPTIONS.map((option) => ({
    value: option.value,
    label: getFeedbackReasonLabel(option.value, lang),
  }));

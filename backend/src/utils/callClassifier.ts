import type { TranscriptEntry } from './types.js';

export type CallCategory =
  | 'update'
  | 'general enquiry'
  | 'internal'
  | 'complaint'
  | 'human request'
  | 'confirmed booking'
  | 'other';

const CALL_TYPE_SYNONYMS: Record<string, CallCategory> = {
  update: 'update',
  'status update': 'update',
  enquiry: 'general enquiry',
  'general enquiry': 'general enquiry',
  'general inquiry': 'general enquiry',
  inquiry: 'general enquiry',
  quote: 'general enquiry',
  'internal call': 'internal',
  internal: 'internal',
  complaint: 'complaint',
  'human request': 'human request',
  human: 'human request',
  'human-request': 'human request',
  'speak to human': 'human request',
  booking: 'confirmed booking',
  'confirmed booking': 'confirmed booking',
  appointment: 'confirmed booking',
  other: 'other',
};

const COMPLAINT_PATTERNS = [
  /\bcomplain(?:ed|t|ing)?\b/i,
  /\bnot\s+(?:happy|satisfied|acceptable)\b/i,
  /\bunhappy\b/i,
  /\bfrustrated\b/i,
  /\bupset\b/i,
  /\bissue\b.*\bwith\b/i,
  /\bproblem\b.*\bwith\b/i,
  /\bpoor\s+service\b/i,
  /\bterrible\b/i,
  /\bdamaged?\b/i,
];

const HUMAN_REQUEST_PATTERNS = [
  /\bspeak to (?:a )?(?:human|person|someone|manager)\b/i,
  /\btalk to (?:a )?(?:human|person|someone)\b/i,
  /\btransfer me\b/i,
  /\bput me through\b/i,
  /\breal person\b/i,
  /\bcan i speak (?:with|to) (?:somebody|someone|a manager)\b/i,
  /\bis there (?:anyone|somebody) i can speak to\b/i,
];

const INTERNAL_PATTERNS = [
  /\b(?:i['’]m|i am) calling from (?:the )?(?:accounts|finance|parts|delivery|supplier|garage|head office|tyre|inventory|fleet|admin|office)\b/i,
  /\bthis is .* from (?:accounts|finance|parts|delivery|supplier|garage|head office|tyre|inventory|fleet|admin|office)\b/i,
  /\bfrom head office\b/i,
  /\binternal note\b/i,
  /\bjust letting the team know\b/i,
  /\bparts delivery\b/i,
  /\binvoice number\b/i,
];

const BOOKING_PATTERNS = [
  /\bbooking (?:is )?confirmed\b/i,
  /\bappointment (?:is )?confirmed\b/i,
  /\bwe(?:'| wi)ll see you on\b/i,
  /\bsee you on\b/i,
  /\bbook(?:ed|ing)? (?:you|in|for)\b/i,
  /\bcan you book\b/i,
  /\bi(?:'d| would) like to book\b/i,
  /\bwant to book\b/i,
  /\bmake an appointment\b/i,
  /\bschedule (?:a|the) (?:service|booking|appointment)\b/i,
  /\bslot available\b/i,
];

const UPDATE_SUBJECT_PATTERN =
  /\b(car|vehicle|van|truck|motorbike|bike|mot|service|job|repair|work|booking|appointment|tyre|tyres|diagnostic|inspection|order|parts?)\b/;

const UPDATE_TRIGGER_PATTERNS = [
  /\b(?:update|status|progress)\b/i,
  /\b(?:ready|finished|done|complete|completed)\b/i,
  /\bany news\b/i,
  /\bjust checking\b/i,
  /\bwhen will\b/i,
  /\bhow is\b/i,
  /\bcan i (?:collect|pick (?:it|her|the car) up)\b/i,
  /\bis (?:it|the) ready\b/i,
  /\bcollect(?:ion)?\b/i,
];

const UPDATE_COMBINATION_PATTERNS = [
  /\bwhen (?:can|will) (?:i|we) (?:collect|pick (?:it|her|the car) up)\b/i,
  /\bwhen (?:will|is) (?:my|the)\b.*\b(?:car|vehicle|service|booking|appointment|job)\b.*\bready\b/i,
  /\b(?:any|an) update on (?:my|the)\b.*\b(?:car|vehicle|service|booking|appointment|job)\b/i,
  /\bcheck(?:ing)? on (?:my|the)\b.*\b(?:car|vehicle|service|booking|appointment|job)\b/i,
  /\bhow is (?:my|the)\b.*\b(?:car|vehicle|service|booking|appointment|job)\b\s*(?:coming|getting on|progressing)?\b/i,
];

const ENQUIRY_PATTERNS = [
  /\bquote\b/i,
  /\bhow much\b/i,
  /\bprice\b/i,
  /\bcost\b/i,
  /\bdo you (?:do|offer|sell)\b/i,
  /\bcan you help with\b/i,
  /\bwhat (?:are|time).*hours\b/i,
  /\bwhere are you located\b/i,
  /\bavailability\b/i,
  /\binformation about\b/i,
];

const normaliseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const buildAnalysisText = (summary?: string | null, transcript?: TranscriptEntry[]) => {
  const parts: string[] = [];
  if (summary) {
    parts.push(summary);
  }
  if (Array.isArray(transcript)) {
    for (const entry of transcript) {
      if (entry?.text) {
        parts.push(entry.text);
      }
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return normaliseWhitespace(parts.join(' ').toLowerCase());
};

const matchesAny = (text: string, patterns: RegExp[]): boolean => {
  if (!text) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(text));
};

const isUpdateCall = (text: string): boolean => {
  if (!text || !UPDATE_SUBJECT_PATTERN.test(text)) {
    return false;
  }

  if (matchesAny(text, UPDATE_COMBINATION_PATTERNS)) {
    return true;
  }

  if (matchesAny(text, UPDATE_TRIGGER_PATTERNS)) {
    // Require the subject keyword to appear close by when using the broader triggers.
    const sentences = text.split(/[.!?]/);
    return sentences.some((sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) {
        return false;
      }
      return UPDATE_SUBJECT_PATTERN.test(trimmed) && UPDATE_TRIGGER_PATTERNS.some((pattern) => pattern.test(trimmed));
    });
  }

  return false;
};

const normaliseIncomingCallType = (rawType?: string | null): CallCategory | null => {
  if (!rawType) {
    return null;
  }
  const cleaned = normaliseWhitespace(rawType.toLowerCase());
  if (!cleaned || cleaned === 'unknown' || cleaned === 'inbound' || cleaned === 'outbound') {
    return null;
  }
  if (CALL_TYPE_SYNONYMS[cleaned]) {
    return CALL_TYPE_SYNONYMS[cleaned];
  }
  return null;
};

export const classifyCallCategory = (
  incomingType: string | null | undefined,
  summary: string,
  transcript: TranscriptEntry[],
): CallCategory => {
  const baselineType = normaliseIncomingCallType(incomingType);
  const analysisText = buildAnalysisText(summary, transcript);

  if (analysisText) {
    if (matchesAny(analysisText, COMPLAINT_PATTERNS)) {
      return 'complaint';
    }

    if (matchesAny(analysisText, HUMAN_REQUEST_PATTERNS)) {
      return 'human request';
    }

    if (matchesAny(analysisText, INTERNAL_PATTERNS)) {
      return 'internal';
    }

    if (matchesAny(analysisText, BOOKING_PATTERNS)) {
      return 'confirmed booking';
    }

    if (isUpdateCall(analysisText)) {
      return 'update';
    }

    if (matchesAny(analysisText, ENQUIRY_PATTERNS)) {
      return 'general enquiry';
    }
  }

  return baselineType ?? 'other';
};

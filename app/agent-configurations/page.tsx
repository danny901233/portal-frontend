'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChangeEvent, FormEvent } from 'react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { ChangeEvent } from 'react';
import {
  deleteKnowledgeDocument,
  discoverWebsitePages,
  fetchAgentConfiguration,
  generateVoicePreview,
  ingestWebsiteKnowledge,
  updateAgentConfiguration,
  uploadKnowledgeDocument,
} from '../lib/api';
import { getGarageId, isReceptionMateStaff } from '../lib/auth';
import { useToast } from '../components/Toast';
import StickySaveBar from '../components/StickySaveBar';
import DataCollectionFieldsSection from './DataCollectionFieldsSection';
import CustomRulesSection from './CustomRulesSection';

// Data Collection Fields + Custom Rules are now GA — every garage admin can
// edit them. Beta gate dropped 2026-06-11.
import {
  createEmptyWeeklyOpeningHours,
  WEEKDAY_ORDER,
} from '../types';
import type {
  AgentConfiguration,
  AgentKnowledgeDocument,
  AgentType,
  DayOfWeek,
  HubspotSettings,
  IntegrationProvider,
  TonePreference,
  TyresoftSettings,
  VoiceOption,
  WeeklyOpeningHours,
  WebsiteScanSummaryPage,
} from '../types';

const DAY_LABELS: Record<DayOfWeek, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

const DEFAULT_OPEN_TIME = '09:00';
const DEFAULT_CLOSE_TIME = '17:00';

const formatTimeForDisplay = (value: string | null) => {
  if (!value) {
    return '--';
  }
  const [hourPart, minutePart] = value.split(':');
  if (!hourPart || !minutePart) {
    return value;
  }
  const hour = Number.parseInt(hourPart, 10);
  if (Number.isNaN(hour)) {
    return value;
  }
  const suffix = hour >= 12 ? 'pm' : 'am';
  const normalizedHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${normalizedHour}:${minutePart} ${suffix}`;
};

const cloneWeeklyOpeningHours = (hours: WeeklyOpeningHours): WeeklyOpeningHours => {
  return WEEKDAY_ORDER.reduce<WeeklyOpeningHours>((acc, day) => {
    const entry = hours?.[day];
    acc[day] = {
      open: entry?.open ?? null,
      close: entry?.close ?? null,
      closed: entry?.closed ?? true,
    };
    return acc;
  }, {} as WeeklyOpeningHours);
};

const createEmptyGarageHiveSettings = (): AgentConfiguration['garageHiveSettings'] => ({
  instanceUrl: '',
  apiKey: '',
  customerId: '',
  locationId: '',
});

const cloneGarageHiveSettings = (
  settings: AgentConfiguration['garageHiveSettings'],
): AgentConfiguration['garageHiveSettings'] => ({
  instanceUrl: settings?.instanceUrl ?? '',
  apiKey: settings?.apiKey ?? '',
  customerId: settings?.customerId ?? '',
  locationId: settings?.locationId ?? '',
});

const createEmptyTyresoftSettings = (): TyresoftSettings => ({
  tsWorkspace: '',
  tsUsername: '',
  tsPassword: '',
  tsApiKey: '',
  tsDepotId: '',
});

const cloneTyresoftSettings = (settings: TyresoftSettings | undefined): TyresoftSettings => ({
  tsWorkspace: settings?.tsWorkspace ?? '',
  tsUsername: settings?.tsUsername ?? '',
  tsPassword: settings?.tsPassword ?? '',
  tsApiKey: settings?.tsApiKey ?? '',
  tsDepotId: settings?.tsDepotId ?? '',
});

const createEmptyHubspotSettings = (): HubspotSettings => ({
  enabled: false,
  apiToken: '',
  ownerId: '',
  inboxEmail: '',
});

const cloneHubspotSettings = (settings: HubspotSettings | undefined): HubspotSettings => ({
  enabled: settings?.enabled === true,
  apiToken: settings?.apiToken ?? '',
  ownerId: settings?.ownerId ?? '',
  inboxEmail: settings?.inboxEmail ?? '',
});

const createEmptyConfiguration = (): AgentConfiguration => ({
  branchName: '',
  agentName: '',
  phoneNumber: '',
  emailAddress: '',
  branchAddress: '',
  websiteUrl: '',
  weeklyOpeningHours: createEmptyWeeklyOpeningHours(),
  holidayClosures: '',
  greetingLine: '',
  tonePreference: 'standard',
  responseSpeed: 'normal',
  interruptionSensitivity: 0.5,
  allowFastFitOnly: false,
  enableDropOffBookings: false,
  dropOffMessage: 'drop your vehicle off between 8am and half ten in the morning',
  dropOffExcludeServices: ['MOT'],
  notificationEmails: [],
  integrationProvider: 'none',
  garageHiveSettings: createEmptyGarageHiveSettings(),
  tyresoftSettings: createEmptyTyresoftSettings(),
  hubspotSettings: createEmptyHubspotSettings(),
  agentType: 'assist',
  agentScript: 'receptionmate-agent-v3',
  enableSmsBookingLinks: true,
  transferNumber: '',
  allowBookings: false,
  bookingLeadTimeDays: 1,
  voice: 'leah',
  dataCollectionFields: null,
  customRules: null,
});

const cloneConfiguration = (config: AgentConfiguration): AgentConfiguration => ({
  ...config,
  // Coerce nullable string fields to '' so React inputs stay controlled.
  // The DB can return null for these (e.g. transferNumber for a never-set garage),
  // but the AgentConfiguration type declares them as string. Without this, an input
  // bound to `value={formState.X}` where X is null becomes uncontrolled - user types
  // but React state does not reconcile, save sends the original null, value disappears
  // on refresh. Fix surfaced 2026-06-18 from a transferNumber save bug on Norwich.
  branchName: config.branchName ?? '',
  agentName: config.agentName ?? '',
  phoneNumber: config.phoneNumber ?? '',
  emailAddress: config.emailAddress ?? '',
  branchAddress: config.branchAddress ?? '',
  websiteUrl: config.websiteUrl ?? '',
  holidayClosures: config.holidayClosures ?? '',
  greetingLine: config.greetingLine ?? '',
  dropOffMessage: config.dropOffMessage ?? '',
  transferNumber: config.transferNumber ?? '',
  weeklyOpeningHours: cloneWeeklyOpeningHours(config.weeklyOpeningHours),
  garageHiveSettings: cloneGarageHiveSettings(config.garageHiveSettings),
  tyresoftSettings: cloneTyresoftSettings(config.tyresoftSettings),
  hubspotSettings: cloneHubspotSettings(config.hubspotSettings),
  dropOffExcludeServices: [...(config.dropOffExcludeServices || ['MOT'])],
});

const describeHoursRange = (entry: { open: string | null; close: string | null; closed: boolean }) => {
  if (entry.closed) {
    return 'Closed';
  }
  if (!entry.open || !entry.close) {
    return 'Not set';
  }
  return `${formatTimeForDisplay(entry.open)} - ${formatTimeForDisplay(entry.close)}`;
};

type TextFieldKey = Exclude<
  keyof AgentConfiguration,
  | 'tonePreference'
  | 'responseSpeed'
  | 'allowFastFitOnly'
  | 'enableDropOffBookings'
  | 'dropOffExcludeServices'
  | 'weeklyOpeningHours'
  | 'interruptionSensitivity'
  | 'integrationProvider'
  | 'garageHiveSettings'
  | 'notificationEmails'
>;

const integrationProviderOptions: { value: IntegrationProvider; label: string; description: string }[] = [
  { value: 'none', label: 'Not connected', description: 'Caller details are captured manually.' },
  {
    value: 'garage_hive',
    label: 'Garage Hive',
    description: 'Let the agent book straight into your Garage Hive diary.',
  },
];

const agentTypeOptions: { value: AgentType; label: string; description: string }[] = [
  { value: 'assist', label: 'Assist', description: 'Collects enquiries and customer details for callback.' },
  { value: 'automate', label: 'Automate', description: 'Handles full booking process with diary integration.' },
];

const agentScriptOptions: { value: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent'; label: string; description: string }[] = [
  { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Enhanced agent with supervisor architecture' },
  { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Original agent architecture' },
  { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Tyresoft tyre centre integration with inventory management' },
  { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'New assist-mode agent on the second LiveKit Cloud account — message-taking only, ElevenLabs voice, supports per-garage customRules + dataCollectionFields' },
  { value: 'GarageHive-agent', label: 'RMB-GarageHive', description: 'New GarageHive booking + take-message agent on the second LiveKit Cloud account — full booking flow, ElevenLabs voice, supports per-garage customRules + dataCollectionFields' },
];
const maskSecretValue = (value: string) => {
  if (!value) {
    return 'Not set';
  }
  if (value.length <= 4) {
    return 'Stored';
  }
  return `${value.slice(0, 4)}****`;
};

const toneOptions: { value: TonePreference; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: 'Balanced default tone' },
  { value: 'upbeat', label: 'Upbeat', description: 'Energetic and warm' },
  { value: 'professional', label: 'Professional', description: 'Formal and precise' },
];

const voiceOptions: { value: VoiceOption; label: string; description: string; elevenLabsId: string }[] = [
  { value: 'tom', label: 'Tom', description: 'A friendly mid thirties voice', elevenLabsId: 'Fahco4VZzobUeiPqni1S' },
  { value: 'leah', label: 'Leah', description: 'A pleasantly clear British female voice', elevenLabsId: 'rfkTsdZrVWEVhDycUYn9' },
  { value: 'sophie', label: 'Sophie', description: 'A clear and conversational female voice', elevenLabsId: 'fq1SdXsX6OokE10pJ4Xw' },
  { value: 'gemma', label: 'Gemma', description: 'A modern Northern English friendly female voice', elevenLabsId: 'IosqM5LMIzqPfT0efhhy' },
  { value: 'isobel', label: 'Isobel', description: 'Scottish female voice, youthful and warm', elevenLabsId: 'h8eW5xfRUGVJrZhAFxqK' },
  { value: 'fraser', label: 'Fraser', description: 'A soft male Scottish Glaswegian voice', elevenLabsId: 'v2zbX16tJNtRIx8rSHDM' },
  { value: 'amelia', label: 'Amelia', description: 'A British female voice', elevenLabsId: '21m00Tcm4TlvDq8ikWAM' },
];

export default function AgentConfigurationsPage() {
  const garageId = getGarageId();
  const [formState, setFormState] = useState<AgentConfiguration>(() => createEmptyConfiguration());
  const [isEditing, setIsEditing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<AgentKnowledgeDocument[]>([]);
  const [discoveredPages, setDiscoveredPages] = useState<WebsiteScanSummaryPage[]>([]);
  const [selectedPageUrls, setSelectedPageUrls] = useState<string[]>([]);
  const [lastScanUrl, setLastScanUrl] = useState<string | null>(null);
  const [newNotificationEmail, setNewNotificationEmail] = useState<string>('');
  const [playingVoice, setPlayingVoice] = useState<VoiceOption | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [, startTransition] = useTransition();
  const canEditAgentType = isReceptionMateStaff();

  const query = useQuery({
    queryKey: ['agent-config', garageId],
    queryFn: () => fetchAgentConfiguration(garageId ?? undefined),
    enabled: Boolean(garageId),
    staleTime: 30000, // 30 seconds
    gcTime: 300000, // 5 minutes
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const toast = useToast();

  const mutation = useMutation({
    mutationFn: (payload: AgentConfiguration) =>
      updateAgentConfiguration(payload, garageId ?? undefined),
    onSuccess: (data) => {
      setFormState(cloneConfiguration(data.configuration));
      setKnowledgeBase(data.knowledgeBase ?? []);
      setIsEditing(false);
      setFeedback(null);
      toast.success('Configuration saved', 'Changes applied to your agent.');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to save configuration. Please try again.';
      setFeedback(null);
      toast.error('Save failed', message);
    },
  });

  const websiteDiscoveryMutation = useMutation({
    mutationFn: (url: string) => discoverWebsitePages(url, garageId ?? undefined),
    onSuccess: (data, scannedUrl) => {
      setLastScanUrl(scannedUrl);
      setDiscoveredPages(data.pages ?? []);
      setSelectedPageUrls((data.pages ?? []).map((page) => page.url));
      setFeedback(
        data.pages.length
          ? 'Select which pages to include, then publish the knowledge base.'
          : 'No crawlable pages were found. Try a different starting URL.',
      );
    },
    onError: (error: unknown) => {
      setLastScanUrl(null);
      setDiscoveredPages([]);
      setSelectedPageUrls([]);
      const message =
        error instanceof Error ? error.message : 'Failed to crawl that website. Please try again.';
      setFeedback(message);
    },
  });

  const websiteIngestMutation = useMutation({
    mutationFn: (payload: { url: string; selectedUrls: string[] }) =>
      ingestWebsiteKnowledge(payload.url, payload.selectedUrls, garageId ?? undefined),
    onSuccess: (data) => {
      setKnowledgeBase(data.knowledgeBase ?? []);
      setDiscoveredPages([]);
      setSelectedPageUrls([]);
      setLastScanUrl(null);
      setFeedback(
        `Knowledge base updated from ${data.processedPages} page${data.processedPages === 1 ? '' : 's'}.`,
      );
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to publish the selected pages. Please try again.';
      setFeedback(message);
    },
  });

  const uploadDocMutation = useMutation({
    mutationFn: (payload: { file: File; kind: 'document' | 'price-list' }) =>
      uploadKnowledgeDocument(payload.file, payload.kind, garageId ?? undefined),
    onSuccess: (data, variables) => {
      setKnowledgeBase(data.knowledgeBase ?? []);
      setFeedback(
        `${variables.kind === 'price-list' ? 'Price list' : 'Document'} added to the knowledge base.`,
      );
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to upload that file. Please try again.';
      toast.error('Upload failed', message);
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: (uploadId: string) => deleteKnowledgeDocument(uploadId, garageId ?? undefined),
    onSuccess: (data) => {
      setKnowledgeBase(data.knowledgeBase ?? []);
      setFeedback('Removed from the knowledge base.');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to remove that document. Please try again.';
      toast.error('Remove failed', message);
    },
  });

  // Group uploaded (non-website) knowledge docs by their uploadId so each file shows as one row.
  const uploadedDocs = useMemo(() => {
    const groups = new Map<string, { uploadId: string; fileName: string; kind: string; chunks: number }>();
    for (const doc of knowledgeBase) {
      if (doc.source !== 'document' && doc.source !== 'price-list') continue;
      const meta = (doc.metadata ?? {}) as { uploadId?: string; fileName?: string; kind?: string };
      const uploadId = meta.uploadId ?? doc.id;
      const existing = groups.get(uploadId);
      if (existing) {
        existing.chunks += 1;
      } else {
        groups.set(uploadId, {
          uploadId,
          fileName: meta.fileName ?? doc.title ?? 'Document',
          kind: meta.kind ?? doc.source,
          chunks: 1,
        });
      }
    }
    return Array.from(groups.values());
  }, [knowledgeBase]);

  // "Give prices" toggle (Assist only): reveals the price-list upload. Its persisted state IS
  // "a price list is uploaded" — the agent quotes only when a price-list doc exists, so turning
  // the toggle off deletes the uploaded price lists (which stops the agent quoting). No DB column.
  const hasPriceList = useMemo(() => uploadedDocs.some((d) => d.kind === 'price-list'), [uploadedDocs]);
  const [pricesEnabled, setPricesEnabled] = useState(false);
  const showPriceUpload = pricesEnabled || hasPriceList;
  const handleTogglePrices = (next: boolean) => {
    setPricesEnabled(next);
    if (!next) {
      uploadedDocs
        .filter((d) => d.kind === 'price-list')
        .forEach((d) => deleteDocMutation.mutate(d.uploadId));
    }
  };

  const handleDocUpload = (kind: 'document' | 'price-list') => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-uploading the same filename
    if (!file) return;
    setFeedback(null);
    uploadDocMutation.mutate({ file, kind });
  };

  const handleWebsiteScan = () => {
    if (!formState.websiteUrl || !formState.websiteUrl.trim()) {
      setFeedback('Enter a website URL before scanning.');
      return;
    }
    const trimmedUrl = formState.websiteUrl.trim();
    setFeedback(null);
    setDiscoveredPages([]);
    setSelectedPageUrls([]);
    setLastScanUrl(null);
    websiteDiscoveryMutation.mutate(trimmedUrl);
  };

  const togglePageSelection = (url: string) => {
    setSelectedPageUrls((prev) =>
      prev.includes(url) ? prev.filter((entry) => entry !== url) : [...prev, url],
    );
    setFeedback(null);
  };

  const handleSelectAllPages = () => {
    setSelectedPageUrls(discoveredPages.map((page) => page.url));
    setFeedback(null);
  };

  const handleClearAllPages = () => {
    setSelectedPageUrls([]);
    setFeedback(null);
  };

  const handleApplySelection = () => {
    if (!selectedPageUrls.length) {
      setFeedback('Select at least one page to include.');
      return;
    }

    const baseUrlCandidate = lastScanUrl ?? formState.websiteUrl.trim();
    if (!baseUrlCandidate) {
      setFeedback('Scan a website before publishing the knowledge base.');
      return;
    }

    setFeedback(null);
    websiteIngestMutation.mutate({ url: baseUrlCandidate, selectedUrls: selectedPageUrls });
  };

  const handleAutoPopulateFromScan = () => {
    if (!discoveredPages.length) {
      setFeedback('No website scan data available.');
      return;
    }

    console.log('=== AUTO-POPULATE DEBUG ===');
    console.log('Discovered pages:', discoveredPages);

    // Aggregate data from all discovered pages
    const allPhoneNumbers: string[] = [];
    const allEmails: string[] = [];
    const allAddresses: string[] = [];
    const allHours: string[] = [];

    discoveredPages.forEach((page, idx) => {
      console.log(`Page ${idx + 1}:`, {
        url: page.url,
        title: page.title,
        phoneNumbers: page.phoneNumbers,
        emails: page.emails,
        address: page.address,
        hours: page.hours,
      });

      if (page.phoneNumbers?.length) allPhoneNumbers.push(...page.phoneNumbers);
      if (page.emails?.length) allEmails.push(...page.emails);
      if (page.address) allAddresses.push(page.address);
      if (page.hours?.length) allHours.push(...page.hours);
    });

    console.log('Aggregated data:', {
      phones: allPhoneNumbers,
      emails: allEmails,
      addresses: allAddresses,
      hours: allHours,
    });

    // Get unique values
    const uniquePhones = [...new Set(allPhoneNumbers)];
    const uniqueEmails = [...new Set(allEmails)];
    const uniqueAddresses = [...new Set(allAddresses)];

    // Update form state with found data
    const updates: Partial<AgentConfiguration> = {};

    if (uniquePhones.length > 0 && !formState.phoneNumber) {
      updates.phoneNumber = uniquePhones[0];
    }

    if (uniqueEmails.length > 0 && !formState.emailAddress) {
      updates.emailAddress = uniqueEmails[0];
    }

    if (uniqueAddresses.length > 0 && !formState.branchAddress) {
      updates.branchAddress = uniqueAddresses[0];
    }

    // Try to parse opening hours from text
    if (allHours.length > 0) {
      console.log('Attempting to parse hours...');
      const parsedHours = parseOpeningHoursFromText(allHours);
      if (parsedHours && Object.keys(parsedHours).length > 0) {
        updates.weeklyOpeningHours = {
          ...formState.weeklyOpeningHours,
          ...parsedHours,
        };
        console.log('Successfully parsed hours, will update form');
      } else {
        console.log('Failed to parse hours from text:', allHours);
      }
    } else {
      console.log('No hours data found in website scan');
    }

    console.log('Final updates to apply:', updates);

    if (Object.keys(updates).length > 0) {
      setFormState(prev => ({ ...prev, ...updates }));
      const updatedFields = Object.keys(updates).join(', ');
      setFeedback(`✓ Populated: ${updatedFields}. ${allHours.length > 0 && !updates.weeklyOpeningHours ? 'Note: Could not parse opening hours format.' : ''}`);
    } else {
      setFeedback('No new information found in scan, or fields already filled. Check console for details.');
    }
  };

  const parseOpeningHoursFromText = (hoursTexts: string[]): Partial<WeeklyOpeningHours> | null => {
    const result: Partial<WeeklyOpeningHours> = {};
    const fullText = hoursTexts.join(' ');

    console.log('Parsing opening hours from:', fullText);

    const dayMap: Record<string, DayOfWeek> = {
      'monday': 'monday', 'mon': 'monday',
      'tuesday': 'tuesday', 'tue': 'tuesday', 'tues': 'tuesday',
      'wednesday': 'wednesday', 'wed': 'wednesday',
      'thursday': 'thursday', 'thu': 'thursday', 'thur': 'thursday', 'thurs': 'thursday',
      'friday': 'friday', 'fri': 'friday',
      'saturday': 'saturday', 'sat': 'saturday',
      'sunday': 'sunday', 'sun': 'sunday',
    };

    // Try to extract day-specific hours
    // Pattern: "Monday: 9:00am - 5:00pm" or "Mon 9am-5pm" or "Monday 09:00 - 17:00"
    const dayHoursPattern = /(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)[:\s]*(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;

    let match;
    while ((match = dayHoursPattern.exec(fullText)) !== null) {
      const dayKey = match[1].toLowerCase();
      const day = dayMap[dayKey];

      if (day) {
        const openTime = convertTo24Hour(`${match[2]}${match[3] ? ':' + match[3] : ''}${match[4] || ''}`);
        const closeTime = convertTo24Hour(`${match[5]}${match[6] ? ':' + match[6] : ''}${match[7] || ''}`);

        if (openTime && closeTime) {
          result[day] = { open: openTime, close: closeTime, closed: false };
          console.log(`Parsed ${day}: ${openTime} - ${closeTime}`);
        }
      }
    }

    // Try to extract range hours like "Monday - Friday: 9am - 5pm" or "Mon-Fri 9:00-17:00"
    const rangePattern = /(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\s*[-–to]+\s*(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)[:\s]*(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;

    while ((match = rangePattern.exec(fullText)) !== null) {
      const startDayKey = match[1].toLowerCase();
      const endDayKey = match[2].toLowerCase();
      const startDay = dayMap[startDayKey];
      const endDay = dayMap[endDayKey];

      if (startDay && endDay) {
        const openTime = convertTo24Hour(`${match[3]}${match[4] ? ':' + match[4] : ''}${match[5] || ''}`);
        const closeTime = convertTo24Hour(`${match[6]}${match[7] ? ':' + match[7] : ''}${match[8] || ''}`);

        if (openTime && closeTime) {
          // Fill in all days in the range
          const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
          const startIdx = dayOrder.indexOf(startDay);
          const endIdx = dayOrder.indexOf(endDay);

          for (let i = startIdx; i <= endIdx; i++) {
            const day = dayOrder[i] as DayOfWeek;
            result[day] = { open: openTime, close: closeTime, closed: false };
            console.log(`Parsed range ${day}: ${openTime} - ${closeTime}`);
          }
        }
      }
    }

    // If no structured hours found, try to extract just times and apply to weekdays
    if (Object.keys(result).length === 0) {
      const timePattern = /(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;
      const timeMatch = timePattern.exec(fullText);

      if (timeMatch) {
        const openTime = convertTo24Hour(`${timeMatch[1]}${timeMatch[2] ? ':' + timeMatch[2] : ''}${timeMatch[3] || ''}`);
        const closeTime = convertTo24Hour(`${timeMatch[4]}${timeMatch[5] ? ':' + timeMatch[5] : ''}${timeMatch[6] || ''}`);

        if (openTime && closeTime) {
          console.log(`Found generic hours: ${openTime} - ${closeTime}, applying to weekdays`);
          ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].forEach(day => {
            result[day as DayOfWeek] = { open: openTime, close: closeTime, closed: false };
          });
        }
      }
    }

    console.log('Parsed hours result:', result);
    return Object.keys(result).length > 0 ? result : null;
  };

  const convertTo24Hour = (timeStr: string): string | null => {
    // Handle formats like "9am", "9:30pm", "09:00", "17:00", "9"
    const normalized = timeStr.trim().toLowerCase();

    // Match various time formats
    const match = normalized.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = match[2] || '00';
    const period = match[3];

    // Handle 12-hour format
    if (period === 'pm' && hours !== 12) {
      hours += 12;
    } else if (period === 'am' && hours === 12) {
      hours = 0;
    } else if (!period && hours < 8) {
      // If no AM/PM specified and hour is very early (< 8), assume PM
      hours += 12;
    }

    // Validate
    if (hours < 0 || hours > 23) return null;

    return `${hours.toString().padStart(2, '0')}:${minutes}`;
  };

  useEffect(() => {
    if (!query.data?.configuration) {
      return;
    }
    // Don't reset form state while user is editing
    if (isEditing) {
      return;
    }
    console.log('FRONTEND: API response agentScript:', query.data.configuration.agentScript);
    startTransition(() => {
      setFormState(cloneConfiguration(query.data.configuration));
      setKnowledgeBase(query.data.knowledgeBase ?? []);
      setDiscoveredPages([]);
      setSelectedPageUrls([]);
      setLastScanUrl(null);
    });
  }, [query.data, startTransition, isEditing]);

  const hasGarage = useMemo(() => Boolean(garageId), [garageId]);

  const ghMisconfigWarning = useMemo(() => {
    const isGhAgent =
      formState.agentScript === 'receptionmate-agent-v3' ||
      formState.agentScript === 'receptionmate-agent';
    if (!isGhAgent) return null;
    if (formState.integrationProvider !== 'garage_hive') {
      return 'This garage is using a GarageHive agent but the Diary Integration is set to "Not connected". The agent will fall back to taking a message instead of booking. Set the integration to Garage Hive and add credentials.';
    }
    const { customerId, apiKey } = formState.garageHiveSettings ?? {};
    if (!customerId?.trim() || !apiKey?.trim()) {
      return 'GarageHive is selected as the integration but Customer ID or API key is missing. The agent will fall back to taking a message instead of booking. Complete the credentials below.';
    }
    return null;
  }, [formState.agentScript, formState.integrationProvider, formState.garageHiveSettings]);

  const knowledgeUpdatedAt = useMemo(() => {
    if (!knowledgeBase.length) {
      return null;
    }

    const timestamps = knowledgeBase
      .map((doc) => {
        const time = Date.parse(doc.updatedAt);
        return Number.isFinite(time) ? time : null;
      })
      .filter((value): value is number => value !== null);

    if (!timestamps.length) {
      return null;
    }

    return new Date(Math.max(...timestamps)).toISOString();
  }, [knowledgeBase]);

  const twilioNumber = query.data?.twilioNumber ?? '';

  const handleInputChange = (field: TextFieldKey) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setFormState((prev) => ({ ...prev, [field]: value }));
      setFeedback(null);
    };

  const scanningSite = websiteDiscoveryMutation.isPending;
  const publishingKnowledge = websiteIngestMutation.isPending;
  const allPagesSelected =
    discoveredPages.length > 0 && selectedPageUrls.length === discoveredPages.length;

  const handleToneChange = (value: TonePreference) => {
    setFormState((prev) => ({ ...prev, tonePreference: value }));
    setFeedback(null);
  };

  const handleVoiceChange = (value: VoiceOption) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    setFormState((prev) => ({ ...prev, voice: value }));
    setFeedback(null);
  };

  const handlePlayVoice = async (voiceId: VoiceOption) => {
    try {
      // Stop currently playing audio
      if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
      }

      setPlayingVoice(voiceId);
      setFeedback(null);

      const audioBlob = await generateVoicePreview(voiceId, garageId ?? undefined);
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setPlayingVoice(null);
        URL.revokeObjectURL(audioUrl);
      };

      audio.onerror = () => {
        setPlayingVoice(null);
        setFeedback('Failed to play voice preview');
        URL.revokeObjectURL(audioUrl);
      };

      setAudioElement(audio);
      await audio.play();
    } catch (error) {
      console.error('Voice preview error:', error);
      setPlayingVoice(null);
      setFeedback('Failed to play voice preview. Please try again.');
    }
  };

  const handleIntegrationProviderChange = (value: IntegrationProvider) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    setFormState((prev) => ({
      ...prev,
      integrationProvider: value,
      garageHiveSettings: cloneGarageHiveSettings(prev.garageHiveSettings),
    }));
    setFeedback(null);
  };

  const handleGarageHiveSettingsChange = (
    field: keyof AgentConfiguration['garageHiveSettings'],
  ) => (event: ChangeEvent<HTMLInputElement>) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    const { value } = event.target;
    setFormState((prev) => ({
      ...prev,
      garageHiveSettings: {
        ...prev.garageHiveSettings,
        [field]: value,
      },
    }));
    setFeedback(null);
  };

  const handleTyresoftSettingsChange = (
    field: keyof TyresoftSettings,
  ) => (event: ChangeEvent<HTMLInputElement>) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    const { value } = event.target;
    setFormState((prev) => ({
      ...prev,
      tyresoftSettings: {
        ...prev.tyresoftSettings,
        [field]: value,
      },
    }));
    setFeedback(null);
  };

  const handleHubspotSettingsChange = (field: keyof HubspotSettings) => (event: ChangeEvent<HTMLInputElement>) => {
    if (!isEditing || mutation.isPending) return;
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setFormState((prev) => ({
      ...prev,
      hubspotSettings: { ...prev.hubspotSettings, [field]: value },
    }));
    setFeedback(null);
  };

  const handleInterruptionSensitivityChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    const rawValue = Number.parseFloat(event.target.value);
    setFormState((prev) => ({
      ...prev,
      interruptionSensitivity: Number.isNaN(rawValue)
        ? prev.interruptionSensitivity
        : Math.min(1, Math.max(0, rawValue)),
    }));
    setFeedback(null);
  };

  const handleHoursChange = (day: DayOfWeek, field: 'open' | 'close') =>
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!isEditing || mutation.isPending) {
        return;
      }
      const rawValue = event.target.value;
      setFormState((prev) => {
        const nextHours = cloneWeeklyOpeningHours(prev.weeklyOpeningHours);
        const current = nextHours[day];
        nextHours[day] = {
          ...current,
          [field]: rawValue ? rawValue : null,
          closed: false,
        };
        return { ...prev, weeklyOpeningHours: nextHours };
      });
      setFeedback(null);
    };

  const handleDayClosedToggle = (day: DayOfWeek) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    setFormState((prev) => {
      const nextHours = cloneWeeklyOpeningHours(prev.weeklyOpeningHours);
      const current = nextHours[day];
      const nextClosed = !current.closed;
      nextHours[day] = {
        open: nextClosed ? null : current.open ?? DEFAULT_OPEN_TIME,
        close: nextClosed ? null : current.close ?? DEFAULT_CLOSE_TIME,
        closed: nextClosed,
      };
      return { ...prev, weeklyOpeningHours: nextHours };
    });
    setFeedback(null);
  };

  const handleToggle = () => {
    setFormState((prev) => ({ ...prev, allowFastFitOnly: !prev.allowFastFitOnly }));
    setFeedback(null);
  };

  const handleDropOffToggle = () => {
    setFormState((prev) => ({ ...prev, enableDropOffBookings: !prev.enableDropOffBookings }));
    setFeedback(null);
  };

  const handleAddNotificationEmail = () => {
    const trimmed = newNotificationEmail.trim();
    if (!trimmed) {
      setFeedback('Please enter an email address.');
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      setFeedback('Please enter a valid email address.');
      return;
    }
    
    if (formState.notificationEmails.includes(trimmed)) {
      setFeedback('This email is already in the notification list.');
      return;
    }
    
    setFormState((prev) => ({
      ...prev,
      notificationEmails: [...prev.notificationEmails, trimmed],
    }));
    setNewNotificationEmail('');
    setFeedback(null);
  };

  const handleRemoveNotificationEmail = (email: string) => {
    setFormState((prev) => ({
      ...prev,
      notificationEmails: prev.notificationEmails.filter((e) => e !== email),
    }));
    setFeedback(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isEditing || mutation.isPending) {
      return;
    }
    console.log('FRONTEND SUBMIT: Sending agentScript:', formState.agentScript);
    mutation.mutate(formState);
  };

  if (!hasGarage) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        Garage not selected. Log out and sign in again to choose a branch.
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        Loading agent configuration…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Agent Configurations</h1>
          <p className="text-sm text-slate-400">
            Tailor your AI agent&rsquo;s behaviour for the selected branch. Changes apply after saving.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-slate-50 disabled:opacity-60"
            onClick={() => {
              setFeedback(null);
              setIsEditing((state) => {
                if (state && query.data?.configuration) {
                  setFormState(cloneConfiguration(query.data.configuration));
                }
                return !state;
              });
            }}
            disabled={query.isLoading || mutation.isPending}
          >
            {isEditing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </header>

      {ghMisconfigWarning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span className="font-semibold">Configuration warning: </span>
          {ghMisconfigWarning}
        </div>
      )}

      {feedback ? (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          {feedback}
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-8">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Branch Details</h2>
          <p className="mt-1 text-sm text-slate-400">
            These details personalise the agent&rsquo;s responses and confirmations.
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Branch name</span>
              <input
                type="text"
                value={formState.branchName}
                onChange={handleInputChange('branchName')}
                disabled={!isEditing || mutation.isPending}
                required
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Branch phone number</span>
              <input
                type="text"
                value={formState.phoneNumber}
                onChange={handleInputChange('phoneNumber')}
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">ReceptionMate number</span>
              <input
                type="text"
                value={twilioNumber}
                readOnly
                placeholder="Not assigned yet"
                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400 focus:border-slate-700 focus:outline-none"
              />
              <span className="text-[11px] text-slate-500">Managed by ReceptionMate staff.</span>
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Primary email</span>
              <input
                type="email"
                value={formState.emailAddress}
                onChange={handleInputChange('emailAddress')}
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Website URL</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={formState.websiteUrl}
                  onChange={handleInputChange('websiteUrl')}
                  disabled={!isEditing || mutation.isPending || scanningSite || publishingKnowledge}
                  className="w-full flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="https://"
                />
                {isEditing ? (
                  <button
                    type="button"
                    onClick={handleWebsiteScan}
                    disabled={
                      mutation.isPending || scanningSite || publishingKnowledge || !formState.websiteUrl
                    }
                    className="inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-sky-500 hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {scanningSite ? 'Scanning…' : 'Scan site'}
                  </button>
                ) : null}
              </div>
            </label>
          </div>

          <label className="mt-5 flex flex-col gap-2 text-sm text-slate-300">
            <span className="text-xs uppercase tracking-wide text-slate-500">Branch address</span>
            <textarea
              value={formState.branchAddress}
              onChange={handleInputChange('branchAddress')}
              disabled={!isEditing || mutation.isPending}
              rows={3}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          
          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Notification emails</span>
              <p className="text-xs text-slate-400">
                Email addresses that will receive a notification after each call with the call summary.
              </p>
              
              {isEditing ? (
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={newNotificationEmail}
                    onChange={(e) => setNewNotificationEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddNotificationEmail();
                      }
                    }}
                    disabled={mutation.isPending}
                    placeholder="Add an email address"
                    className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={handleAddNotificationEmail}
                    disabled={mutation.isPending || !newNotificationEmail.trim()}
                    className="rounded-md border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-sky-500 hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Add
                  </button>
                </div>
              ) : null}
              
              {formState.notificationEmails.length > 0 ? (
                <div className="mt-2 space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                  {formState.notificationEmails.map((email) => (
                    <div
                      key={email}
                      className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/60 bg-slate-950/60 px-3 py-2"
                    >
                      <span className="text-sm text-slate-100">{email}</span>
                      {isEditing ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveNotificationEmail(email)}
                          disabled={mutation.isPending}
                          className="text-xs text-rose-400 transition hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 rounded-xl border border-slate-800/70 bg-slate-900/50 p-3 text-xs text-slate-400">
                  {isEditing ? 'No notification emails added yet.' : 'No notification emails configured.'}
                </div>
              )}
            </label>
          </div>
        </section>

        {formState.agentType === 'assist' && (
          <>
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
              <h2 className="text-lg font-semibold text-slate-100">Booking Preferences</h2>
              <p className="mt-1 text-sm text-slate-400">
                Configure how the agent handles booking requests from customers.
              </p>

              <div className="mt-6 flex items-center justify-between">
                <div className="flex-1">
                  <span className="text-sm font-medium text-slate-300">
                    Allow bookings
                  </span>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Enable the agent to capture booking requests with specific dates
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setFormState((prev) => ({
                      ...prev,
                      allowBookings: !prev.allowBookings
                    }))
                  }
                  disabled={!isEditing || mutation.isPending}
                  className={`inline-flex w-fit items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium transition ${
                    formState.allowBookings
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                      : 'border-slate-700 bg-slate-900/60 text-slate-200'
                  } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  <span
                    className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                      formState.allowBookings ? 'bg-emerald-500/70' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`absolute h-4 w-4 rounded-full bg-slate-950 transition-transform ${
                        formState.allowBookings ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </span>
                  {formState.allowBookings ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              {formState.allowBookings && (
                <div className="mt-6 rounded-lg border border-slate-700 bg-slate-950/40 p-4">
                  <label htmlFor="bookingLeadTime" className="block text-sm font-medium text-slate-300">
                    Booking lead time (days)
                  </label>
                  <p className="mt-1 text-xs text-slate-400">
                    Minimum number of days notice required for bookings
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      type="number"
                      id="bookingLeadTime"
                      min="1"
                      max="30"
                      value={formState.bookingLeadTimeDays}
                      onChange={(e) =>
                        setFormState((prev) => ({
                          ...prev,
                          bookingLeadTimeDays: Math.max(1, Math.min(30, Number.parseInt(e.target.value, 10) || 1))
                        }))
                      }
                      disabled={!isEditing || mutation.isPending}
                      className="block w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-sm text-slate-400">days</span>
                  </div>
                  <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
                    <p className="text-xs text-sky-200">
                      {formState.bookingLeadTimeDays === 1
                        ? 'Customers can book for today or any future date.'
                        : `Customers must book at least ${formState.bookingLeadTimeDays} day${formState.bookingLeadTimeDays === 1 ? '' : 's'} in advance.`}
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
              <h2 className="text-lg font-semibold text-slate-100">SMS Booking Links</h2>
              <p className="mt-1 text-sm text-slate-400">
                When enabled, the agent will offer to send customers a text message with a link to book an appointment online. The SMS contains the <strong>Website URL</strong> configured above, so it&rsquo;s best to enter a direct link to your booking page rather than just your homepage.
              </p>

            <div className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
              <p className="text-xs text-sky-200">
                <strong>Tip:</strong> Enter your online booking page URL (e.g., https://yourbusiness.com/book) in the Website URL field above for the best customer experience.
              </p>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-200">
                <strong>Billing Note:</strong> SMS messages are charged at £0.99 per message. When disabled, the agent will take customer details for callback without offering the SMS option.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <span className="text-sm text-slate-300">
                Enable SMS booking links
              </span>
              <button
                type="button"
                onClick={() =>
                  setFormState((prev) => ({
                    ...prev,
                    enableSmsBookingLinks: !prev.enableSmsBookingLinks
                  }))
                }
                disabled={!isEditing || mutation.isPending}
                className={`inline-flex w-fit items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium transition ${
                  formState.enableSmsBookingLinks
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                    : 'border-slate-700 bg-slate-900/60 text-slate-200'
                } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span
                  className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                    formState.enableSmsBookingLinks ? 'bg-emerald-500/70' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`absolute h-4 w-4 rounded-full bg-slate-950 transition-transform ${
                      formState.enableSmsBookingLinks ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </span>
                {formState.enableSmsBookingLinks ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          </section>
          </>
        )}

        <CustomRulesSection
          rules={formState.customRules ?? null}
          disabled={mutation.isPending}
          onChange={(nextRules) => {
            setFormState((prev) => (prev ? { ...prev, customRules: nextRules } : prev));
            setIsEditing(true);
          }}
        />

        <DataCollectionFieldsSection
          fields={formState.dataCollectionFields ?? null}
          disabled={mutation.isPending}
          onChange={(nextFields) => {
            setFormState((prev) => (prev ? { ...prev, dataCollectionFields: nextFields } : prev));
            setIsEditing(true);
          }}
        />

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Agent knowledge base</h2>
              <p className="text-sm text-slate-400">
                Scans publish structured information that the agent can reference during calls. Trigger a new scan to refresh this content.
              </p>
            </div>
            <div className="text-xs text-slate-500">
              {knowledgeUpdatedAt
                ? `Last updated ${new Date(knowledgeUpdatedAt).toLocaleString()}`
                : 'Not published yet'}
            </div>
          </div>

          {scanningSite ? (
            <div className="mt-4 rounded-xl border border-slate-800/70 bg-slate-950/60 p-4 text-sm text-slate-300">
              Scanning website… this usually takes a few moments.
            </div>
          ) : null}

          {discoveredPages.length ? (
            <div className="mt-4 space-y-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-100">
                    {`Discovered ${discoveredPages.length} page${discoveredPages.length === 1 ? '' : 's'}`}
                  </p>
                  <p className="text-xs text-slate-400">
                    Tick the pages you want in the agent&rsquo;s knowledge base, then publish.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    onClick={handleAutoPopulateFromScan}
                    disabled={publishingKnowledge}
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-medium text-emerald-400 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    ✨ Auto-fill details
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllPages}
                    disabled={publishingKnowledge || allPagesSelected}
                    className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1 font-medium text-slate-200 transition hover:border-sky-500 hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAllPages}
                    disabled={publishingKnowledge || selectedPageUrls.length === 0}
                    className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1 font-medium text-slate-200 transition hover:border-rose-500 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {discoveredPages.map((page) => {
                  const isChecked = selectedPageUrls.includes(page.url);
                  return (
                    <label
                      key={page.url}
                      className="flex items-start gap-3 rounded-lg border border-slate-800/70 bg-slate-900/60 p-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500"
                        checked={isChecked}
                        onChange={() => togglePageSelection(page.url)}
                        disabled={publishingKnowledge}
                      />
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <span className="text-sm font-semibold text-slate-100">
                            {page.title?.trim() || 'Untitled page'}
                          </span>
                          <span className="text-xs text-slate-500 break-all">
                            {page.url}
                          </span>
                        </div>
                        {page.description ? (
                          <p className="text-xs text-slate-300">{page.description}</p>
                        ) : null}
                        {page.snippet ? (
                          <p className="text-xs text-slate-400">{page.snippet}</p>
                        ) : null}
                        <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
                          {page.chunkCount ? (
                            <span className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5">
                              {`${page.chunkCount} section${page.chunkCount === 1 ? '' : 's'}`}
                            </span>
                          ) : null}
                          {page.phoneNumbers.length ? (
                            <span className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5">
                              {`${page.phoneNumbers.length} phone${page.phoneNumbers.length === 1 ? '' : 's'}`}
                            </span>
                          ) : null}
                          {page.emails.length ? (
                            <span className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5">
                              {`${page.emails.length} email${page.emails.length === 1 ? '' : 's'}`}
                            </span>
                          ) : null}
                          {page.hours.length ? (
                            <span className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5">
                              {`${page.hours.length} hours row${page.hours.length === 1 ? '' : 's'}`}
                            </span>
                          ) : null}
                          {page.address ? (
                            <span className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5">
                              Address found
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-400">
                  {`Selected ${selectedPageUrls.length} page${selectedPageUrls.length === 1 ? '' : 's'}`}
                </span>
                <button
                  type="button"
                  onClick={handleApplySelection}
                  disabled={publishingKnowledge || selectedPageUrls.length === 0}
                  className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {publishingKnowledge
                    ? 'Publishing…'
                    : `Publish selected pages (${selectedPageUrls.length})`}
                </button>
              </div>
            </div>
          ) : null}

          {!discoveredPages.length && !scanningSite ? (
            <p className="mt-4 rounded-xl border border-slate-800/70 bg-slate-900/60 p-4 text-sm text-slate-400">
              Start a website scan to discover pages and choose which ones to publish to the agent&rsquo;s knowledge base.
            </p>
          ) : null}

          {/* Document & price-list uploads — parsed, chunked, and retrieved per-call (no prompt bloat). */}
          <div className="mt-6 border-t border-slate-800 pt-5">
            <h3 className="text-sm font-semibold text-slate-100">Documents &amp; price lists</h3>
            <p className="mt-1 text-xs text-slate-400">
              Upload a PDF, Word, CSV, Excel, or text file. The agent reads only the relevant part during a call, so large files won&rsquo;t slow it down.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-sky-500 hover:text-sky-100">
                {uploadDocMutation.isPending ? 'Uploading…' : '+ Upload document'}
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.txt,.md"
                  className="hidden"
                  disabled={uploadDocMutation.isPending}
                  onChange={handleDocUpload('document')}
                />
              </label>
              {formState.agentType === 'assist' && showPriceUpload ? (
                <label className="cursor-pointer rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/20">
                  {uploadDocMutation.isPending ? 'Uploading…' : '+ Upload price list'}
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.txt,.md"
                    className="hidden"
                    disabled={uploadDocMutation.isPending}
                    onChange={handleDocUpload('price-list')}
                  />
                </label>
              ) : null}
            </div>
            {formState.agentType === 'assist' ? (
              <div className="mt-3 rounded-lg border border-slate-800/70 bg-slate-950/40 p-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={showPriceUpload}
                    onChange={(event) => handleTogglePrices(event.target.checked)}
                    disabled={deleteDocMutation.isPending}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-slate-200">Give prices on calls</span>
                </label>
                <p className="mt-1.5 pl-7 text-[11px] text-slate-500">
                  {showPriceUpload
                    ? 'Upload a price list above — the agent quotes ONLY the figures in it, never an invented price.'
                    : 'Off by default. Turn this on to upload a price list the agent can quote from. Turning it off removes any uploaded price list.'}
                </p>
              </div>
            ) : null}
            {uploadedDocs.length ? (
              <ul className="mt-4 space-y-2">
                {uploadedDocs.map((doc) => (
                  <li
                    key={doc.uploadId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/70 bg-slate-950/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-200">{doc.fileName}</p>
                      <p className="text-[11px] text-slate-500">
                        {doc.kind === 'price-list' ? 'Price list' : 'Document'} · {doc.chunks} section{doc.chunks === 1 ? '' : 's'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteDocMutation.mutate(doc.uploadId)}
                      disabled={deleteDocMutation.isPending}
                      className="shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-medium text-slate-300 transition hover:border-rose-500 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No documents uploaded yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Availability & Messaging</h2>
          <p className="mt-1 text-sm text-slate-400">
            Let the assistant know when the branch is open and how to greet callers.
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Weekly opening hours</span>
              {isEditing ? (
                <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="hidden grid-cols-[minmax(110px,0.4fr)_repeat(2,minmax(0,1fr))_auto] items-center gap-3 px-3 text-xs uppercase tracking-wide text-slate-500 md:grid">
                    <span>Day</span>
                    <span>Opens</span>
                    <span>Closes</span>
                    <span>Status</span>
                  </div>
                  {WEEKDAY_ORDER.map((day) => {
                    const hours = formState.weeklyOpeningHours[day];
                    return (
                      <div
                        key={day}
                        className="grid grid-cols-[minmax(110px,0.4fr)_repeat(2,minmax(0,1fr))_auto] items-center gap-3 rounded-lg border border-slate-800/60 bg-slate-950/60 px-3 py-2"
                      >
                        <span className="text-sm font-medium text-slate-100">{DAY_LABELS[day]}</span>
                        <input
                          type="time"
                          aria-label={`${DAY_LABELS[day]} opening time`}
                          value={hours.open ?? ''}
                          onChange={handleHoursChange(day, 'open')}
                          disabled={!isEditing || mutation.isPending || hours.closed}
                          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <input
                          type="time"
                          aria-label={`${DAY_LABELS[day]} closing time`}
                          value={hours.close ?? ''}
                          onChange={handleHoursChange(day, 'close')}
                          disabled={!isEditing || mutation.isPending || hours.closed}
                          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => handleDayClosedToggle(day)}
                          disabled={!isEditing || mutation.isPending}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                            hours.closed
                              ? 'border-rose-500/70 bg-rose-500/10 text-rose-200 hover:border-rose-400 hover:text-rose-100'
                              : 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400 hover:text-emerald-50'
                          } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                        >
                          {hours.closed ? 'Closed' : 'Open'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                  {WEEKDAY_ORDER.map((day) => {
                    const hours = formState.weeklyOpeningHours[day];
                    return (
                      <div key={day} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-slate-400">{DAY_LABELS[day]}</span>
                        <span className="text-slate-100">{describeHoursRange(hours)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-slate-500">
                Select opening and closing times in 24-hour format. Mark a day as closed when the branch is shut.
              </p>
            </div>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Holiday closures</span>
              <textarea
                value={formState.holidayClosures}
                onChange={handleInputChange('holidayClosures')}
                disabled={!isEditing || mutation.isPending}
                rows={4}
                placeholder="e.g. Closed 24-26 Dec, reduced hours 31 Dec"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Greeting line</span>
              <input
                type="text"
                value={formState.greetingLine}
                onChange={handleInputChange('greetingLine')}
                disabled={!isEditing || mutation.isPending}
                placeholder="e.g. Thanks for calling ReceptionMate Garage"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Transfer number</span>
              <input
                type="text"
                value={formState.transferNumber}
                onChange={handleInputChange('transferNumber')}
                disabled={!isEditing || mutation.isPending}
                placeholder="e.g. 07700 900123"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="text-xs text-slate-500">When a caller asks to speak to a human, the AI will transfer them to this number.</span>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Tone & Booking Rules</h2>
          <p className="mt-1 text-sm text-slate-400">
            Control how the AI sounds and how it handles booking requests.
          </p>

          <div className="mt-6">
            <span className="text-xs uppercase tracking-wide text-slate-500">Voice</span>
            <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {voiceOptions.map((option) => {
                const isSelected = formState.voice === option.value;
                const isPlaying = playingVoice === option.value;
                return (
                  <div
                    key={option.value}
                    className={`rounded-xl border p-4 text-sm transition ${
                      isSelected
                        ? 'border-purple-500 bg-purple-500/15'
                        : 'border-slate-800 bg-slate-900/50'
                    }`}
                  >
                    <button
                      type="button"
                      className={`w-full text-left mb-3 ${
                        isSelected ? 'text-slate-100' : 'text-slate-300 hover:text-slate-200'
                      } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                      onClick={() => handleVoiceChange(option.value)}
                      disabled={!isEditing || mutation.isPending}
                    >
                      <div className="text-sm font-semibold">{option.label}</div>
                      <div className="mt-1 text-xs text-slate-400">{option.description}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePlayVoice(option.value)}
                      disabled={isPlaying || !formState.greetingLine}
                      className={`w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
                        isPlaying
                          ? 'bg-purple-500 text-white'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100'
                      } ${!formState.greetingLine ? 'cursor-not-allowed opacity-40' : ''}`}
                      title={!formState.greetingLine ? 'Add a greeting line to preview voices' : 'Play preview'}
                    >
                      {isPlaying ? (
                        <>
                          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" />
                          </svg>
                          <span>Playing...</span>
                        </>
                      ) : (
                        <>
                          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" />
                          </svg>
                          <span>Preview Voice</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {!formState.greetingLine && (
              <p className="mt-2 text-xs text-amber-400">
                💡 Add a greeting line above to enable voice previews
              </p>
            )}
          </div>

          <div className="mt-8">
            <span className="text-xs uppercase tracking-wide text-slate-500">Tone preference</span>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              {toneOptions.map((option) => {
                const isSelected = formState.tonePreference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                      isSelected
                        ? 'border-sky-500 bg-sky-500/15 text-slate-100'
                        : 'border-slate-800 bg-slate-900/50 text-slate-300 hover:border-slate-700 hover:text-slate-200'
                    } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                    onClick={() => {
                      if (!isEditing || mutation.isPending) return;
                      handleToneChange(option.value);
                    }}
                    disabled={!isEditing || mutation.isPending}
                  >
                    <div className="text-sm font-semibold">{option.label}</div>
                    <div className="mt-1 text-xs text-slate-400">{option.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-3 text-sm text-slate-300">
            <span className="text-xs uppercase tracking-wide text-slate-500">Response timing</span>
            {isEditing ? (
              <label className="flex flex-col gap-2">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={formState.interruptionSensitivity}
                  onChange={handleInterruptionSensitivityChange}
                  disabled={!isEditing || mutation.isPending}
                  aria-valuemin={0}
                  aria-valuemax={1}
                  aria-valuenow={Number(formState.interruptionSensitivity.toFixed(1))}
                  aria-valuetext={`${formState.interruptionSensitivity.toFixed(1)} timing`}
                  className="h-2 w-full cursor-pointer rounded-full bg-slate-800 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <span className="text-xs text-slate-400">{formState.interruptionSensitivity.toFixed(1)} (0 = longer pause, 1 = faster response)</span>
              </label>
            ) : (
              <span className="text-sm text-slate-200">{formState.interruptionSensitivity.toFixed(1)}</span>
            )}
          </div>

          <div className="mt-6 flex flex-col gap-3 text-sm text-slate-300">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              <span className="inline-flex items-center gap-2">
                Allow fast fit bookings only
                <span
                  className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[11px] text-slate-300 transition focus-visible:border-slate-400 focus-visible:text-slate-100 focus-visible:outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label="For all other bookings the agent will take a message"
                >
                  i
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-48 -translate-x-1/2 translate-y-2 rounded-md bg-slate-800 px-3 py-2 text-left text-[11px] font-normal text-slate-100 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                    For all other bookings the agent will take a message.
                  </span>
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={handleToggle}
              disabled={!isEditing || mutation.isPending}
              className={`inline-flex w-fit items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium transition ${
                formState.allowFastFitOnly
                  ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                  : 'border-slate-700 bg-slate-900/60 text-slate-200'
              } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <span
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                  formState.allowFastFitOnly ? 'bg-emerald-500/70' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`absolute h-4 w-4 rounded-full bg-slate-950 transition-transform ${
                    formState.allowFastFitOnly ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </span>
              {formState.allowFastFitOnly ? 'Yes' : 'No'}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Drop-Off Bookings</h2>
          <p className="mt-1 text-sm text-slate-400">
            Allow date-only bookings with flexible drop-off times instead of specific timeslots.
          </p>

          <div className="mt-6 flex flex-col gap-3 text-sm text-slate-300">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              <span className="inline-flex items-center gap-2">
                Enable drop-off booking mode
                <span
                  className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[11px] text-slate-300 transition focus-visible:border-slate-400 focus-visible:text-slate-100 focus-visible:outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label="When enabled, agent offers dates only (not specific times) for most services"
                >
                  i
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-48 -translate-x-1/2 translate-y-2 rounded-md bg-slate-800 px-3 py-2 text-left text-[11px] font-normal text-slate-100 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                    When enabled, agent offers dates only (not specific times) for most services. Specific timeslots are still used for excluded services like MOTs.
                  </span>
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={handleDropOffToggle}
              disabled={!isEditing || mutation.isPending}
              className={`inline-flex w-fit items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium transition ${
                formState.enableDropOffBookings
                  ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                  : 'border-slate-700 bg-slate-900/60 text-slate-200'
              } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <span
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                  formState.enableDropOffBookings ? 'bg-emerald-500/70' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`absolute h-4 w-4 rounded-full bg-slate-950 transition-transform ${
                    formState.enableDropOffBookings ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </span>
              {formState.enableDropOffBookings ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          {formState.enableDropOffBookings && (
            <>
              <div className="mt-6">
                <label className="flex flex-col gap-2 text-sm text-slate-300">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    <span className="inline-flex items-center gap-2">
                      Drop-off message
                      <span
                        className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[11px] text-slate-300 transition focus-visible:border-slate-400 focus-visible:text-slate-100 focus-visible:outline-none"
                        tabIndex={0}
                        role="button"
                        aria-label="Message the agent includes when confirming drop-off bookings"
                      >
                        i
                        <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-64 -translate-x-1/2 translate-y-2 rounded-md bg-slate-800 px-3 py-2 text-left text-[11px] font-normal text-slate-100 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                          The agent will say this message when confirming a drop-off booking. Example: &quot;drop your vehicle off between 8am and half ten in the morning&quot;
                        </span>
                      </span>
                    </span>
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={formState.dropOffMessage || ''}
                      onChange={(e) => setFormState((prev) => ({ ...prev, dropOffMessage: e.target.value }))}
                      placeholder="drop your vehicle off between 8-10:30am"
                      disabled={mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  ) : (
                    <span className="text-sm text-slate-200">{formState.dropOffMessage || 'Not set'}</span>
                  )}
                </label>
              </div>

              <div className="mt-6">
                <label className="flex flex-col gap-2 text-sm text-slate-300">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    <span className="inline-flex items-center gap-2">
                      Excluded services (comma-separated)
                      <span
                        className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[11px] text-slate-300 transition focus-visible:border-slate-400 focus-visible:text-slate-100 focus-visible:outline-none"
                        tabIndex={0}
                        role="button"
                        aria-label="Services that should still use specific timeslots instead of drop-off mode"
                      >
                        i
                        <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-64 -translate-x-1/2 translate-y-2 rounded-md bg-slate-800 px-3 py-2 text-left text-[11px] font-normal text-slate-100 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                          Services listed here will still use specific timeslots instead of drop-off mode. Useful for services like MOTs that require the vehicle at a specific time.
                        </span>
                      </span>
                    </span>
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={(formState.dropOffExcludeServices || []).join(', ')}
                      onChange={(e) =>
                        setFormState((prev) => ({
                          ...prev,
                          dropOffExcludeServices: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                      placeholder="MOT, Diagnostic"
                      disabled={mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  ) : (
                    <span className="text-sm text-slate-200">
                      {(formState.dropOffExcludeServices || []).join(', ') || 'None'}
                    </span>
                  )}
                </label>
              </div>
            </>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Agent Type</h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose which agent handles calls for this garage.
          </p>

          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Agent</span>
              <select
                value={formState.agentType}
                onChange={(event) =>
                  setFormState((state) => ({
                    ...state,
                    agentType: event.target.value as AgentType,
                  }))
                }
                disabled={!isEditing || mutation.isPending || !canEditAgentType}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {agentTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {agentTypeOptions.find((option) => option.value === formState.agentType)?.description ?? ''}
              </span>
              {!canEditAgentType && (
                <span className="text-xs text-amber-400">
                  Only ReceptionMate staff can change the agent type.
                </span>
              )}
            </label>
          </div>

          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">Agent Version (A/B Testing)</span>
              <select
                value={formState.agentScript}
                onChange={(event) =>
                  setFormState((state) => ({
                    ...state,
                    agentScript: event.target.value as 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent',
                  }))
                }
                disabled={!isEditing || mutation.isPending || !canEditAgentType}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {agentScriptOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {agentScriptOptions.find((option) => option.value === formState.agentScript)?.description ?? ''}
              </span>
              <span className="text-xs text-slate-400">
                🧪 Select which agent script to use for this garage. Use for A/B testing and safe rollback.
              </span>
              {!canEditAgentType && (
                <span className="text-xs text-amber-400">
                  Only ReceptionMate staff can change agent version.
                </span>
              )}
            </label>
          </div>
        </section>

        {formState.agentScript === 'tyresoft-agent' && canEditAgentType && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
            <h2 className="text-lg font-semibold text-slate-100">Tyresoft Configuration</h2>
            <p className="mt-1 text-sm text-slate-400">
              API credentials for the Tyresoft tyre centre integration.
            </p>
            <div className="mt-6">
              {isEditing ? (
                <div className="grid gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Workspace</span>
                    <input
                      type="text"
                      placeholder="e.g. test"
                      value={formState.tyresoftSettings.tsWorkspace}
                      onChange={handleTyresoftSettingsChange('tsWorkspace')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Username</span>
                    <input
                      type="text"
                      value={formState.tyresoftSettings.tsUsername}
                      onChange={handleTyresoftSettingsChange('tsUsername')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Password</span>
                    <input
                      type="password"
                      value={formState.tyresoftSettings.tsPassword}
                      onChange={handleTyresoftSettingsChange('tsPassword')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">API Key</span>
                    <input
                      type="password"
                      value={formState.tyresoftSettings.tsApiKey}
                      onChange={handleTyresoftSettingsChange('tsApiKey')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Depot ID</span>
                    <input
                      type="text"
                      placeholder="e.g. 1"
                      value={formState.tyresoftSettings.tsDepotId}
                      onChange={handleTyresoftSettingsChange('tsDepotId')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">Workspace</span>
                    <div className="text-slate-100">{formState.tyresoftSettings.tsWorkspace || 'Not set'}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">Username</span>
                    <div className="text-slate-100">{formState.tyresoftSettings.tsUsername || 'Not set'}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">Password</span>
                    <div className="text-slate-100">{maskSecretValue(formState.tyresoftSettings.tsPassword)}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">API Key</span>
                    <div className="text-slate-100">{maskSecretValue(formState.tyresoftSettings.tsApiKey)}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">Depot ID</span>
                    <div className="text-slate-100">{formState.tyresoftSettings.tsDepotId || 'Not set'}</div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Diary Integration</h2>
          <p className="mt-1 text-sm text-slate-400">
            Connect your garage management system so the agent can check availability or secure bookings during calls.
          </p>

          <div className="mt-6 space-y-5">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">System</span>
              <select
                value={formState.integrationProvider}
                onChange={(event) =>
                  handleIntegrationProviderChange(event.target.value as IntegrationProvider)
                }
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {integrationProviderOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {integrationProviderOptions.find((option) => option.value === formState.integrationProvider)?.description ?? ''}
              </span>
            </label>

            {formState.integrationProvider === 'garage_hive' ? (
              isEditing ? (
                <div className="grid gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Garage Hive instance</span>
                    <input
                      type="text"
                      placeholder="Your instance provided by Garage Hive"
                      value={formState.garageHiveSettings.instanceUrl}
                      onChange={handleGarageHiveSettingsChange('instanceUrl')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      Enter the exact instance name supplied by Garage Hive. Use letters, numbers, dashes, underscores, or dots only.
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Garage Hive API key</span>
                    <input
                      type="password"
                      value={formState.garageHiveSettings.apiKey}
                      onChange={handleGarageHiveSettingsChange('apiKey')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      Stored securely and only visible to you while editing.
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Customer ID</span>
                    <input
                      type="text"
                      value={formState.garageHiveSettings.customerId}
                      onChange={handleGarageHiveSettingsChange('customerId')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      Your unique Garage Hive customer identifier for this branch.
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-300">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Location ID</span>
                    <input
                      type="text"
                      value={formState.garageHiveSettings.locationId}
                      onChange={handleGarageHiveSettingsChange('locationId')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      Provide the exact Garage Hive location or branch identifier the agent should book into.
                    </span>
                  </label>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">System</span>
                      <div className="text-slate-100">Garage Hive</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Instance</span>
                      <div className="text-slate-100">
                        {formState.garageHiveSettings.instanceUrl || 'Not set'}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">API key</span>
                      <div className="text-slate-100">
                        {maskSecretValue(formState.garageHiveSettings.apiKey)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Customer ID</span>
                      <div className="text-slate-100">
                        {formState.garageHiveSettings.customerId || 'Not set'}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Location ID</span>
                      <div className="text-slate-100">
                        {formState.garageHiveSettings.locationId || 'Not set'}
                      </div>
                    </div>
                  </div>
                </div>
              )
            ) : (
              !isEditing && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
                  No diary integration configured.
                </div>
              )
            )}
          </div>
        </section>

        {/* CRM Integration — HubSpot */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">CRM Integration</h2>
          <p className="mt-1 text-sm text-slate-400">
            Connect HubSpot so every inbound call automatically creates a contact and a conversation thread in your Conversations inbox.
          </p>
          <div className="mt-6 space-y-5">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formState.hubspotSettings?.enabled === true}
                onChange={handleHubspotSettingsChange('enabled')}
                disabled={!isEditing || mutation.isPending}
                className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500 disabled:cursor-not-allowed"
              />
              <span className="text-sm text-slate-300">Enable HubSpot CRM integration</span>
            </label>

            {formState.hubspotSettings?.enabled && (
              isEditing ? (
                <div className="flex flex-col gap-5">
                  <div className="rounded-xl border border-sky-800/40 bg-sky-950/30 p-4 text-sm text-slate-300">
                    <p className="mb-3 font-medium text-sky-300">How to set up HubSpot integration</p>
                    <ol className="flex flex-col gap-2 text-slate-400 list-decimal list-inside">
                      <li>Log in to HubSpot → Settings (top-right gear icon).</li>
                      <li>Go to <span className="text-slate-200">Integrations → Legacy Apps</span> → create or open your app.</li>
                      <li>Under Scopes, enable: <code className="text-sky-300">crm.objects.contacts.read</code>, <code className="text-sky-300">crm.objects.contacts.write</code>, <code className="text-sky-300">tickets</code>, <code className="text-sky-300">crm.objects.calls.write</code>.</li>
                      <li>Copy the token (starts with <code className="text-sky-300">pat-</code>) and paste it below.</li>
                      <li>Optionally enter your HubSpot Owner ID to assign tickets and calls to a specific user. Leave blank to log without an owner.</li>
                    </ol>
                  </div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <label className="flex flex-col gap-2 text-sm text-slate-300 md:col-span-2">
                      <span className="text-xs uppercase tracking-wide text-slate-500">HubSpot API Token</span>
                      <input
                        type="password"
                        placeholder="pat-na1-..."
                        value={formState.hubspotSettings?.apiToken ?? ''}
                        onChange={handleHubspotSettingsChange('apiToken')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="flex flex-col gap-2 text-sm text-slate-300 md:col-span-2">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Inbox Email Address (optional)</span>
                      <input
                        type="email"
                        placeholder="support@12345.hs-inbox.com"
                        value={formState.hubspotSettings?.inboxEmail ?? ''}
                        onChange={handleHubspotSettingsChange('inboxEmail')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span className="text-xs text-slate-500">When set, each call will also appear as a new message in your HubSpot Conversations inbox — just like a form submission.</span>
                    </label>
                    <label className="flex flex-col gap-2 text-sm text-slate-300">
                      <span className="text-xs uppercase tracking-wide text-slate-500">HubSpot Owner ID (optional)</span>
                      <input
                        type="text"
                        placeholder="e.g. 11349275740"
                        value={formState.hubspotSettings?.ownerId ?? ''}
                        onChange={handleHubspotSettingsChange('ownerId')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span className="text-xs text-slate-500">Assign call records to a specific HubSpot user. Leave blank to log without an owner.</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Private App Token</span>
                      <div className="text-slate-100">{formState.hubspotSettings?.apiToken ? '••••••••••••••••' : 'Not set'}</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Inbox Email</span>
                      <div className="text-slate-100">{formState.hubspotSettings?.inboxEmail || 'Not set'}</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">Owner ID</span>
                      <div className="text-slate-100">{formState.hubspotSettings?.ownerId || 'Not set'}</div>
                    </div>
                  </div>
                </div>
              )
            )}
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-sky-500 px-6 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!isEditing || mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </form>

      {query.isError ? (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Failed to load configuration.{' '}
          {query.error instanceof Error ? query.error.message : 'Please try again later.'}
        </div>
      ) : null}

      <StickySaveBar
        visible={isEditing}
        saving={mutation.isPending}
        summary="Review your changes, then save to apply them to your agent."
        onSave={() => mutation.mutate(formState)}
        onDiscard={() => {
          if (query.data) {
            setFormState(cloneConfiguration(query.data.configuration));
          }
          setIsEditing(false);
          setFeedback(null);
        }}
      />
    </div>
  );
}

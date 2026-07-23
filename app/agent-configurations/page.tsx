'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useLang } from '@/app/i18n/LocaleProvider';
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

const DAY_LABELS_BY_LANG: Record<'en' | 'fr', Record<DayOfWeek, string>> = {
  en: {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  },
  fr: {
    monday: 'Lundi',
    tuesday: 'Mardi',
    wednesday: 'Mercredi',
    thursday: 'Jeudi',
    friday: 'Vendredi',
    saturday: 'Samedi',
    sunday: 'Dimanche',
  },
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

const describeHoursRange = (
  entry: { open: string | null; close: string | null; closed: boolean },
  lang: 'en' | 'fr' = 'en',
) => {
  if (entry.closed) {
    return lang === 'fr' ? 'Fermé' : 'Closed';
  }
  if (!entry.open || !entry.close) {
    return lang === 'fr' ? 'Non défini' : 'Not set';
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

type IntegrationProviderOption = { value: IntegrationProvider; label: string; description: string };
const buildIntegrationProviderOptions = (lang: 'en' | 'fr'): IntegrationProviderOption[] =>
  lang === 'fr'
    ? [
        { value: 'none', label: 'Non connecté', description: 'Les coordonnées des appelants sont saisies manuellement.' },
        {
          value: 'garage_hive',
          label: 'Garage Hive',
          description: "Laissez l'agent réserver directement dans votre agenda Garage Hive.",
        },
      ]
    : [
        { value: 'none', label: 'Not connected', description: 'Caller details are captured manually.' },
        {
          value: 'garage_hive',
          label: 'Garage Hive',
          description: 'Let the agent book straight into your Garage Hive diary.',
        },
      ];

type AgentTypeOption = { value: AgentType; label: string; description: string };
const buildAgentTypeOptions = (lang: 'en' | 'fr'): AgentTypeOption[] =>
  lang === 'fr'
    ? [
        { value: 'assist', label: 'Assist', description: 'Recueille les demandes et les coordonnées des clients pour un rappel.' },
        { value: 'automate', label: 'Automate', description: "Gère l'intégralité du processus de réservation avec l'intégration de l'agenda." },
      ]
    : [
        { value: 'assist', label: 'Assist', description: 'Collects enquiries and customer details for callback.' },
        { value: 'automate', label: 'Automate', description: 'Handles full booking process with diary integration.' },
      ];

type AgentScriptOption = { value: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent' | 'bookar-agent'; label: string; description: string };
const buildAgentScriptOptions = (lang: 'en' | 'fr'): AgentScriptOption[] =>
  lang === 'fr'
    ? [
        { value: 'receptionmate-agent-v3', label: 'Nouvel agent', description: 'Agent amélioré avec architecture superviseur' },
        { value: 'receptionmate-agent', label: 'Agent hérité', description: 'Architecture agent d’origine' },
        { value: 'tyresoft-agent', label: 'Agent Tyresoft', description: 'Intégration du centre de pneus Tyresoft avec gestion des stocks' },
        { value: 'Assist-agent', label: 'RMB-Assist (Compte 2)', description: 'Nouvel agent en mode assist sur le deuxième compte LiveKit Cloud — prise de message uniquement, voix ElevenLabs, prend en charge customRules + dataCollectionFields par garage' },
        { value: 'GarageHive-agent', label: 'RMB-GarageHive', description: 'Nouvel agent de réservation + prise de message GarageHive sur le deuxième compte LiveKit Cloud — flux de réservation complet, voix ElevenLabs, prend en charge customRules + dataCollectionFields par garage' },
        { value: 'MMH-agent', label: 'Agent MMH (Midlands Motorhome Hire)', description: "Agent de réservation de location de camping-cars (Outdoorsy/Wheelbase) sur le projet LiveKit new-gh-agent. Route via LIVEKIT_SIP_DOMAIN_MMH — n'utilisez pas le provisionnement SIP standard pour ce garage." },
        { value: 'bookar-agent', label: 'Agent Bookar (Vitara Commerce)', description: "Agent de prise de rendez-vous pour les garages utilisant Bookar (système de gestion Vitara Commerce). Sur le projet LiveKit dédié « bookar deploy » — flux de réservation complet via l'API Partner de Bookar. Route via LIVEKIT_SIP_DOMAIN_BOOKAR — n'utilisez pas le provisionnement SIP standard." },
      ]
    : [
        { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Enhanced agent with supervisor architecture' },
        { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Original agent architecture' },
        { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Tyresoft tyre centre integration with inventory management' },
        { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'New assist-mode agent on the second LiveKit Cloud account — message-taking only, ElevenLabs voice, supports per-garage customRules + dataCollectionFields' },
        { value: 'GarageHive-agent', label: 'RMB-GarageHive', description: 'New GarageHive booking + take-message agent on the second LiveKit Cloud account — full booking flow, ElevenLabs voice, supports per-garage customRules + dataCollectionFields' },
        { value: 'MMH-agent', label: 'MMH Agent (Midlands Motorhome Hire)', description: 'Dedicated motorhome-hire booking agent (Outdoorsy/Wheelbase) on the new-gh-agent LiveKit project. Routes via LIVEKIT_SIP_DOMAIN_MMH — do not use the standard SIP provisioning for this garage.' },
        { value: 'bookar-agent', label: 'Bookar Agent (Vitara Commerce)', description: 'Garage-appointments agent for garages running Bookar (Vitara Commerce garage management). On the dedicated "bookar deploy" LiveKit project — full booking flow via Bookar Partner API. Routes via LIVEKIT_SIP_DOMAIN_BOOKAR — do not use the standard SIP provisioning for this garage.' },
      ];
const maskSecretValue = (value: string, lang: 'en' | 'fr' = 'en') => {
  if (!value) {
    return lang === 'fr' ? 'Non défini' : 'Not set';
  }
  if (value.length <= 4) {
    return lang === 'fr' ? 'Enregistré' : 'Stored';
  }
  return `${value.slice(0, 4)}****`;
};

type ToneOption = { value: TonePreference; label: string; description: string };
const buildToneOptions = (lang: 'en' | 'fr'): ToneOption[] =>
  lang === 'fr'
    ? [
        { value: 'standard', label: 'Standard', description: 'Ton par défaut équilibré' },
        { value: 'upbeat', label: 'Enjoué', description: 'Énergique et chaleureux' },
        { value: 'professional', label: 'Professionnel', description: 'Formel et précis' },
      ]
    : [
        { value: 'standard', label: 'Standard', description: 'Balanced default tone' },
        { value: 'upbeat', label: 'Upbeat', description: 'Energetic and warm' },
        { value: 'professional', label: 'Professional', description: 'Formal and precise' },
      ];

type VoiceOpt = { value: VoiceOption; label: string; description: string; elevenLabsId: string };
const buildVoiceOptions = (lang: 'en' | 'fr'): VoiceOpt[] =>
  lang === 'fr'
    ? [
        { value: 'tom', label: 'Tom', description: 'Une voix masculine amicale, la trentaine', elevenLabsId: 'Fahco4VZzobUeiPqni1S' },
        { value: 'leah', label: 'Leah', description: 'Une voix féminine britannique agréablement claire', elevenLabsId: 'rfkTsdZrVWEVhDycUYn9' },
        { value: 'sophie', label: 'Sophie', description: 'Une voix féminine claire et conversationnelle', elevenLabsId: 'fq1SdXsX6OokE10pJ4Xw' },
        { value: 'gemma', label: 'Gemma', description: "Une voix féminine amicale, anglais moderne du Nord", elevenLabsId: 'IosqM5LMIzqPfT0efhhy' },
        { value: 'isobel', label: 'Isobel', description: 'Voix féminine écossaise, jeune et chaleureuse', elevenLabsId: 'h8eW5xfRUGVJrZhAFxqK' },
        { value: 'fraser', label: 'Fraser', description: 'Une voix masculine écossaise douce (Glasgow)', elevenLabsId: 'v2zbX16tJNtRIx8rSHDM' },
        { value: 'amelia', label: 'Amelia', description: 'Une voix féminine britannique', elevenLabsId: '21m00Tcm4TlvDq8ikWAM' },
      ]
    : [
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
  const lang = useLang();
  const DAY_LABELS = DAY_LABELS_BY_LANG[lang];
  const integrationProviderOptions = buildIntegrationProviderOptions(lang);
  const agentTypeOptions = buildAgentTypeOptions(lang);
  const agentScriptOptions = buildAgentScriptOptions(lang);
  const toneOptions = buildToneOptions(lang);
  const voiceOptions = buildVoiceOptions(lang);
  const c = {
    en: {
      noGarage: 'Garage not selected. Log out and sign in again to choose a branch.',
      loading: 'Loading agent configuration…',
      pageTitle: 'Agent Configurations',
      pageSubtitle: 'Tailor your AI agent’s behaviour for the selected branch. Changes apply after saving.',
      cancel: 'Cancel',
      edit: 'Edit',
      configWarningLabel: 'Configuration warning: ',
      // Branch Details
      branchDetails: 'Branch Details',
      branchDetailsDesc: 'These details personalise the agent’s responses and confirmations.',
      branchName: 'Branch name',
      branchPhone: 'Branch phone number',
      rmNumber: 'ReceptionMate number',
      notAssignedYet: 'Not assigned yet',
      managedByStaff: 'Managed by ReceptionMate staff.',
      primaryEmail: 'Primary email',
      websiteUrl: 'Website URL',
      scanning: 'Scanning…',
      scanSite: 'Scan site',
      branchAddress: 'Branch address',
      notificationEmails: 'Notification emails',
      notificationEmailsDesc: 'Email addresses that will receive a notification after each call with the call summary.',
      addEmailPlaceholder: 'Add an email address',
      add: 'Add',
      remove: 'Remove',
      noEmailsEditing: 'No notification emails added yet.',
      noEmailsView: 'No notification emails configured.',
      // Booking Preferences
      bookingPreferences: 'Booking Preferences',
      bookingPreferencesDesc: 'Configure how the agent handles booking requests from customers.',
      allowBookings: 'Allow bookings',
      allowBookingsDesc: 'Enable the agent to capture booking requests with specific dates',
      enabled: 'Enabled',
      disabled: 'Disabled',
      bookingLeadTime: 'Booking lead time (days)',
      bookingLeadTimeDesc: 'Minimum number of days notice required for bookings',
      days: 'days',
      leadTimeToday: 'Customers can book for today or any future date.',
      leadTimeAdvance: (n: number) => `Customers must book at least ${n} day${n === 1 ? '' : 's'} in advance.`,
      // SMS Booking Links
      smsBookingLinks: 'SMS Booking Links',
      smsBookingLinksDesc1: 'When enabled, the agent will offer to send customers a text message with a link to book an appointment online. The SMS contains the ',
      websiteUrlBold: 'Website URL',
      smsBookingLinksDesc2: ' configured above, so it’s best to enter a direct link to your booking page rather than just your homepage.',
      tipLabel: 'Tip:',
      smsTip: ' Enter your online booking page URL (e.g., https://yourbusiness.com/book) in the Website URL field above for the best customer experience.',
      billingNoteLabel: 'Billing Note:',
      smsBillingNote: ' SMS messages are charged at £0.99 per message. When disabled, the agent will take customer details for callback without offering the SMS option.',
      enableSms: 'Enable SMS booking links',
      // Knowledge base
      knowledgeBase: 'Agent knowledge base',
      knowledgeBaseDesc: 'Scans publish structured information that the agent can reference during calls. Trigger a new scan to refresh this content.',
      lastUpdated: (d: string) => `Last updated ${d}`,
      notPublishedYet: 'Not published yet',
      scanningWebsite: 'Scanning website… this usually takes a few moments.',
      discoveredPages: (n: number) => `Discovered ${n} page${n === 1 ? '' : 's'}`,
      tickPages: 'Tick the pages you want in the agent’s knowledge base, then publish.',
      autoFill: '✨ Auto-fill details',
      selectAll: 'Select all',
      clear: 'Clear',
      untitledPage: 'Untitled page',
      sectionsBadge: (n: number) => `${n} section${n === 1 ? '' : 's'}`,
      phonesBadge: (n: number) => `${n} phone${n === 1 ? '' : 's'}`,
      emailsBadge: (n: number) => `${n} email${n === 1 ? '' : 's'}`,
      hoursRowsBadge: (n: number) => `${n} hours row${n === 1 ? '' : 's'}`,
      addressFound: 'Address found',
      selectedPages: (n: number) => `Selected ${n} page${n === 1 ? '' : 's'}`,
      publishing: 'Publishing…',
      publishSelected: (n: number) => `Publish selected pages (${n})`,
      startScanHint: 'Start a website scan to discover pages and choose which ones to publish to the agent’s knowledge base.',
      docsAndPriceLists: 'Documents & price lists',
      docsDesc: 'Upload a PDF, Word, CSV, Excel, or text file. The agent reads only the relevant part during a call, so large files won’t slow it down.',
      uploading: 'Uploading…',
      uploadDocument: '+ Upload document',
      uploadPriceList: '+ Upload price list',
      givePrices: 'Give prices on calls',
      pricesOn: 'Upload a price list above — the agent quotes ONLY the figures in it, never an invented price.',
      pricesOff: 'Off by default. Turn this on to upload a price list the agent can quote from. Turning it off removes any uploaded price list.',
      priceListLabel: 'Price list',
      documentLabel: 'Document',
      docSections: (n: number) => `${n} section${n === 1 ? '' : 's'}`,
      noDocs: 'No documents uploaded yet.',
      // Availability & Messaging
      availabilityMessaging: 'Availability & Messaging',
      availabilityDesc: 'Let the assistant know when the branch is open and how to greet callers.',
      weeklyHours: 'Weekly opening hours',
      day: 'Day',
      opens: 'Opens',
      closes: 'Closes',
      status: 'Status',
      openingTimeAria: (d: string) => `${d} opening time`,
      closingTimeAria: (d: string) => `${d} closing time`,
      closed: 'Closed',
      open: 'Open',
      hoursHint: 'Select opening and closing times in 24-hour format. Mark a day as closed when the branch is shut.',
      holidayClosures: 'Holiday closures',
      holidayPlaceholder: 'e.g. Closed 24-26 Dec, reduced hours 31 Dec',
      greetingLine: 'Greeting line',
      greetingPlaceholder: 'e.g. Thanks for calling ReceptionMate Garage',
      transferNumber: 'Transfer number',
      transferPlaceholder: 'e.g. 07700 900123',
      transferHint: 'When a caller asks to speak to a human, the AI will transfer them to this number.',
      // Tone & Booking Rules
      toneBookingRules: 'Tone & Booking Rules',
      toneBookingDesc: 'Control how the AI sounds and how it handles booking requests.',
      voice: 'Voice',
      playing: 'Playing...',
      previewVoice: 'Preview Voice',
      addGreetingToPreview: 'Add a greeting line to preview voices',
      playPreview: 'Play preview',
      greetingHint: '💡 Add a greeting line above to enable voice previews',
      tonePreference: 'Tone preference',
      allowFastFitTitle: 'Allow fast fit bookings only',
      allowFastFitAria: 'For all other bookings the agent will take a message',
      allowFastFitTooltip: 'For all other bookings the agent will take a message.',
      yes: 'Yes',
      no: 'No',
      // Drop-off
      dropOffBookings: 'Drop-Off Bookings',
      dropOffDesc: 'Allow date-only bookings with flexible drop-off times instead of specific timeslots.',
      enableDropOff: 'Enable drop-off booking mode',
      enableDropOffAria: 'When enabled, agent offers dates only (not specific times) for most services',
      enableDropOffTooltip: 'When enabled, agent offers dates only (not specific times) for most services. Specific timeslots are still used for excluded services like contrôle technique.',
      dropOffMessage: 'Drop-off message',
      dropOffMessageAria: 'Message the agent includes when confirming drop-off bookings',
      dropOffMessageTooltip: 'The agent will say this message when confirming a drop-off booking. Example: "drop your vehicle off between 8am and half ten in the morning"',
      dropOffMessagePlaceholder: 'drop your vehicle off between 8-10:30am',
      notSet: 'Not set',
      excludedServices: 'Services booked at set times, not drop-off (comma-separated)',
      excludedServicesAria: 'Services booked at specific timeslots instead of drop-off mode',
      excludedServicesTooltip: 'These services are booked at a set appointment time (on the hour, 9am–4pm) instead of a drop-off. Everything else is offered as a drop-off. Useful for MOTs / contrôle technique that need the vehicle at a specific time.',
      excludedPlaceholder: 'MOT, Diagnostic',
      none: 'None',
      // Agent Type
      agentType: 'Agent Type',
      agentTypeDesc: 'Choose which agent handles calls for this garage.',
      agent: 'Agent',
      onlyStaffAgentType: 'Only ReceptionMate staff can change the agent type.',
      agentVersion: 'Agent Version (A/B Testing)',
      agentScriptHint: '🧪 Select which agent script to use for this garage. Use for A/B testing and safe rollback.',
      onlyStaffAgentVersion: 'Only ReceptionMate staff can change agent version.',
      // Tyresoft
      tyresoftConfig: 'Tyresoft Configuration',
      tyresoftDesc: 'API credentials for the Tyresoft tyre centre integration.',
      workspace: 'Workspace',
      username: 'Username',
      password: 'Password',
      apiKey: 'API Key',
      depotId: 'Depot ID',
      workspacePlaceholder: 'e.g. test',
      depotPlaceholder: 'e.g. 1',
      // Diary Integration
      diaryIntegration: 'Diary Integration',
      diaryDesc: 'Connect your garage management system so the agent can check availability or secure bookings during calls.',
      system: 'System',
      ghInstance: 'Garage Hive instance',
      ghInstancePlaceholder: 'Your instance provided by Garage Hive',
      ghInstanceHint: 'Enter the exact instance name supplied by Garage Hive. Use letters, numbers, dashes, underscores, or dots only.',
      ghApiKey: 'Garage Hive API key',
      ghApiKeyHint: 'Stored securely and only visible to you while editing.',
      customerId: 'Customer ID',
      customerIdHint: 'Your unique Garage Hive customer identifier for this branch.',
      locationId: 'Location ID',
      locationIdHint: 'Provide the exact Garage Hive location or branch identifier the agent should book into.',
      instance: 'Instance',
      ghApiKeyShort: 'API key',
      noDiaryIntegration: 'No diary integration configured.',
      // CRM / HubSpot
      crmIntegration: 'CRM Integration',
      crmDesc: 'Connect HubSpot so every inbound call automatically creates a contact and a conversation thread in your Conversations inbox.',
      enableHubspot: 'Enable HubSpot CRM integration',
      hubspotSetupTitle: 'How to set up HubSpot integration',
      hubspotStep1: 'Log in to HubSpot → Settings (top-right gear icon).',
      hubspotStep2a: 'Go to ',
      hubspotStep2b: 'Integrations → Legacy Apps',
      hubspotStep2c: ' → create or open your app.',
      hubspotStep3a: 'Under Scopes, enable: ',
      hubspotStep3b: '.',
      hubspotStep4a: 'Copy the token (starts with ',
      hubspotStep4b: ') and paste it below.',
      hubspotStep5: 'Optionally enter your HubSpot Owner ID to assign tickets and calls to a specific user. Leave blank to log without an owner.',
      hubspotApiToken: 'HubSpot API Token',
      hubspotInboxEmail: 'Inbox Email Address (optional)',
      hubspotInboxHint: 'When set, each call will also appear as a new message in your HubSpot Conversations inbox — just like a form submission.',
      hubspotOwnerId: 'HubSpot Owner ID (optional)',
      hubspotOwnerIdPlaceholder: 'e.g. 11349275740',
      hubspotOwnerHint: 'Assign call records to a specific HubSpot user. Leave blank to log without an owner.',
      privateAppToken: 'Private App Token',
      inboxEmail: 'Inbox Email',
      ownerId: 'Owner ID',
      // Save / errors
      saving: 'Saving…',
      saveConfiguration: 'Save configuration',
      failedToLoad: 'Failed to load configuration. ',
      tryAgainLater: 'Please try again later.',
      reviewChanges: 'Review your changes, then save to apply them to your agent.',
      // toasts / feedback
      configSaved: ['Configuration saved', 'Changes applied to your agent.'] as const,
      saveFailed: 'Save failed',
      saveFailedFallback: 'Failed to save configuration. Please try again.',
      selectPagesThenPublish: 'Select which pages to include, then publish the knowledge base.',
      noCrawlablePages: 'No crawlable pages were found. Try a different starting URL.',
      crawlFailedFallback: 'Failed to crawl that website. Please try again.',
      knowledgeUpdatedFrom: (n: number) => `Knowledge base updated from ${n} page${n === 1 ? '' : 's'}.`,
      publishFailedFallback: 'Failed to publish the selected pages. Please try again.',
      docAddedToKb: (isPrice: boolean) => `${isPrice ? 'Price list' : 'Document'} added to the knowledge base.`,
      uploadFailed: 'Upload failed',
      uploadFailedFallback: 'Failed to upload that file. Please try again.',
      removedFromKb: 'Removed from the knowledge base.',
      removeFailed: 'Remove failed',
      removeFailedFallback: 'Failed to remove that document. Please try again.',
      enterWebsiteBeforeScan: 'Enter a website URL before scanning.',
      selectAtLeastOnePage: 'Select at least one page to include.',
      scanBeforePublish: 'Scan a website before publishing the knowledge base.',
      noScanData: 'No website scan data available.',
      populated: (fields: string, hoursNote: string) => `✓ Populated: ${fields}. ${hoursNote}`,
      couldNotParseHours: 'Note: Could not parse opening hours format.',
      noNewInfo: 'No new information found in scan, or fields already filled. Check console for details.',
      enterEmail: 'Please enter an email address.',
      enterValidEmail: 'Please enter a valid email address.',
      emailAlready: 'This email is already in the notification list.',
      voicePreviewFailed: 'Failed to play voice preview',
      voicePreviewFailedRetry: 'Failed to play voice preview. Please try again.',
    },
    fr: {
      noGarage: 'Aucun garage sélectionné. Déconnectez-vous et reconnectez-vous pour choisir une agence.',
      loading: 'Chargement de la configuration de l’agent…',
      pageTitle: 'Configurations de l’agent',
      pageSubtitle: 'Personnalisez le comportement de votre agent IA pour l’agence sélectionnée. Les modifications s’appliquent après l’enregistrement.',
      cancel: 'Annuler',
      edit: 'Modifier',
      configWarningLabel: 'Avertissement de configuration : ',
      branchDetails: 'Détails de l’agence',
      branchDetailsDesc: 'Ces détails personnalisent les réponses et les confirmations de l’agent.',
      branchName: 'Nom de l’agence',
      branchPhone: 'Numéro de téléphone de l’agence',
      rmNumber: 'Numéro ReceptionMate',
      notAssignedYet: 'Pas encore attribué',
      managedByStaff: 'Géré par le personnel de ReceptionMate.',
      primaryEmail: 'E-mail principal',
      websiteUrl: 'URL du site web',
      scanning: 'Analyse…',
      scanSite: 'Analyser le site',
      branchAddress: 'Adresse de l’agence',
      notificationEmails: 'E-mails de notification',
      notificationEmailsDesc: 'Adresses e-mail qui recevront une notification après chaque appel avec le résumé de l’appel.',
      addEmailPlaceholder: 'Ajouter une adresse e-mail',
      add: 'Ajouter',
      remove: 'Supprimer',
      noEmailsEditing: 'Aucun e-mail de notification ajouté pour le moment.',
      noEmailsView: 'Aucun e-mail de notification configuré.',
      bookingPreferences: 'Préférences de réservation',
      bookingPreferencesDesc: 'Configurez la manière dont l’agent gère les demandes de réservation des clients.',
      allowBookings: 'Autoriser les réservations',
      allowBookingsDesc: 'Permettre à l’agent d’enregistrer des demandes de réservation à des dates précises',
      enabled: 'Activé',
      disabled: 'Désactivé',
      bookingLeadTime: 'Délai de réservation (jours)',
      bookingLeadTimeDesc: 'Nombre minimum de jours de préavis requis pour les réservations',
      days: 'jours',
      leadTimeToday: 'Les clients peuvent réserver pour aujourd’hui ou toute date future.',
      leadTimeAdvance: (n: number) => `Les clients doivent réserver au moins ${n} jour${n === 1 ? '' : 's'} à l’avance.`,
      smsBookingLinks: 'Liens de réservation par SMS',
      smsBookingLinksDesc1: 'Lorsqu’activé, l’agent proposera d’envoyer aux clients un SMS contenant un lien pour prendre rendez-vous en ligne. Le SMS contient l’',
      websiteUrlBold: 'URL du site web',
      smsBookingLinksDesc2: ' configurée ci-dessus ; il est donc préférable de saisir un lien direct vers votre page de réservation plutôt que votre simple page d’accueil.',
      tipLabel: 'Astuce :',
      smsTip: ' Saisissez l’URL de votre page de réservation en ligne (par ex. https://votreentreprise.com/reserver) dans le champ URL du site web ci-dessus pour une meilleure expérience client.',
      billingNoteLabel: 'Note de facturation :',
      smsBillingNote: ' Les SMS sont facturés £0.99 par message. Lorsqu’il est désactivé, l’agent prend les coordonnées du client pour un rappel sans proposer l’option SMS.',
      enableSms: 'Activer les liens de réservation par SMS',
      knowledgeBase: 'Base de connaissances de l’agent',
      knowledgeBaseDesc: 'Les analyses publient des informations structurées auxquelles l’agent peut se référer pendant les appels. Lancez une nouvelle analyse pour actualiser ce contenu.',
      lastUpdated: (d: string) => `Dernière mise à jour ${d}`,
      notPublishedYet: 'Pas encore publié',
      scanningWebsite: 'Analyse du site web… cela prend généralement quelques instants.',
      discoveredPages: (n: number) => `${n} page${n === 1 ? '' : 's'} découverte${n === 1 ? '' : 's'}`,
      tickPages: 'Cochez les pages que vous souhaitez dans la base de connaissances de l’agent, puis publiez.',
      autoFill: '✨ Remplissage automatique des détails',
      selectAll: 'Tout sélectionner',
      clear: 'Effacer',
      untitledPage: 'Page sans titre',
      sectionsBadge: (n: number) => `${n} section${n === 1 ? '' : 's'}`,
      phonesBadge: (n: number) => `${n} téléphone${n === 1 ? '' : 's'}`,
      emailsBadge: (n: number) => `${n} e-mail${n === 1 ? '' : 's'}`,
      hoursRowsBadge: (n: number) => `${n} ligne${n === 1 ? '' : 's'} d’horaires`,
      addressFound: 'Adresse trouvée',
      selectedPages: (n: number) => `${n} page${n === 1 ? '' : 's'} sélectionnée${n === 1 ? '' : 's'}`,
      publishing: 'Publication…',
      publishSelected: (n: number) => `Publier les pages sélectionnées (${n})`,
      startScanHint: 'Lancez une analyse de site web pour découvrir des pages et choisir lesquelles publier dans la base de connaissances de l’agent.',
      docsAndPriceLists: 'Documents et grilles tarifaires',
      docsDesc: 'Téléversez un fichier PDF, Word, CSV, Excel ou texte. L’agent ne lit que la partie pertinente pendant un appel, de sorte que les gros fichiers ne le ralentissent pas.',
      uploading: 'Téléversement…',
      uploadDocument: '+ Téléverser un document',
      uploadPriceList: '+ Téléverser une grille tarifaire',
      givePrices: 'Donner les prix pendant les appels',
      pricesOn: 'Téléversez une grille tarifaire ci-dessus — l’agent ne cite QUE les chiffres qu’elle contient, jamais un prix inventé.',
      pricesOff: 'Désactivé par défaut. Activez cette option pour téléverser une grille tarifaire à partir de laquelle l’agent peut citer des prix. La désactiver supprime toute grille tarifaire téléversée.',
      priceListLabel: 'Grille tarifaire',
      documentLabel: 'Document',
      docSections: (n: number) => `${n} section${n === 1 ? '' : 's'}`,
      noDocs: 'Aucun document téléversé pour le moment.',
      availabilityMessaging: 'Disponibilité et messages',
      availabilityDesc: 'Indiquez à l’assistant quand l’agence est ouverte et comment accueillir les appelants.',
      weeklyHours: 'Horaires d’ouverture hebdomadaires',
      day: 'Jour',
      opens: 'Ouvre',
      closes: 'Ferme',
      status: 'Statut',
      openingTimeAria: (d: string) => `Heure d’ouverture ${d}`,
      closingTimeAria: (d: string) => `Heure de fermeture ${d}`,
      closed: 'Fermé',
      open: 'Ouvert',
      hoursHint: 'Sélectionnez les heures d’ouverture et de fermeture au format 24 heures. Marquez un jour comme fermé lorsque l’agence est fermée.',
      holidayClosures: 'Fermetures pour congés',
      holidayPlaceholder: 'ex. Fermé du 24 au 26 déc., horaires réduits le 31 déc.',
      greetingLine: 'Phrase d’accueil',
      greetingPlaceholder: 'ex. Merci d’appeler ReceptionMate Garage',
      transferNumber: 'Numéro de transfert',
      transferPlaceholder: 'ex. 07700 900123',
      transferHint: 'Lorsqu’un appelant demande à parler à une personne, l’IA le transfère vers ce numéro.',
      toneBookingRules: 'Ton et règles de réservation',
      toneBookingDesc: 'Contrôlez la voix de l’IA et la manière dont elle gère les demandes de réservation.',
      voice: 'Voix',
      playing: 'Lecture...',
      previewVoice: 'Écouter la voix',
      addGreetingToPreview: 'Ajoutez une phrase d’accueil pour écouter les voix',
      playPreview: 'Écouter l’aperçu',
      greetingHint: '💡 Ajoutez une phrase d’accueil ci-dessus pour activer les aperçus de voix',
      tonePreference: 'Préférence de ton',
      allowFastFitTitle: 'Autoriser uniquement les réservations montage rapide',
      allowFastFitAria: 'Pour toutes les autres réservations, l’agent prendra un message',
      allowFastFitTooltip: 'Pour toutes les autres réservations, l’agent prendra un message.',
      yes: 'Oui',
      no: 'Non',
      dropOffBookings: 'Réservations en dépôt',
      dropOffDesc: 'Autorisez les réservations à la date uniquement, avec des heures de dépôt flexibles au lieu de créneaux précis.',
      enableDropOff: 'Activer le mode de réservation en dépôt',
      enableDropOffAria: 'Lorsqu’activé, l’agent propose uniquement des dates (pas d’heures précises) pour la plupart des services',
      enableDropOffTooltip: 'Lorsqu’activé, l’agent propose uniquement des dates (pas d’heures précises) pour la plupart des services. Des créneaux précis sont toujours utilisés pour les services exclus comme le contrôle technique.',
      dropOffMessage: 'Message de dépôt',
      dropOffMessageAria: 'Message que l’agent inclut lors de la confirmation des réservations en dépôt',
      dropOffMessageTooltip: 'L’agent prononcera ce message lors de la confirmation d’une réservation en dépôt. Exemple : « déposez votre véhicule entre 8h et 10h30 le matin »',
      dropOffMessagePlaceholder: 'déposez votre véhicule entre 8h et 10h30',
      notSet: 'Non défini',
      excludedServices: 'Services à horaire fixe, pas en dépôt (séparés par des virgules)',
      excludedServicesAria: 'Services réservés à des créneaux précis plutôt qu’en mode dépôt',
      excludedServicesTooltip: 'Ces services sont réservés à une heure précise (à l’heure pile, de 9h à 16h) plutôt qu’en dépôt. Tout le reste est proposé en dépôt. Utile pour le contrôle technique qui nécessite le véhicule à une heure précise.',
      excludedPlaceholder: 'MOT, Diagnostic',
      none: 'Aucun',
      agentType: 'Type d’agent',
      agentTypeDesc: 'Choisissez quel agent gère les appels pour ce garage.',
      agent: 'Agent',
      onlyStaffAgentType: 'Seul le personnel de ReceptionMate peut modifier le type d’agent.',
      agentVersion: 'Version de l’agent (test A/B)',
      agentScriptHint: '🧪 Sélectionnez le script d’agent à utiliser pour ce garage. À utiliser pour les tests A/B et un retour arrière en toute sécurité.',
      onlyStaffAgentVersion: 'Seul le personnel de ReceptionMate peut modifier la version de l’agent.',
      tyresoftConfig: 'Configuration Tyresoft',
      tyresoftDesc: 'Identifiants API pour l’intégration du centre de pneus Tyresoft.',
      workspace: 'Espace de travail',
      username: 'Nom d’utilisateur',
      password: 'Mot de passe',
      apiKey: 'Clé API',
      depotId: 'ID du dépôt',
      workspacePlaceholder: 'ex. test',
      depotPlaceholder: 'ex. 1',
      diaryIntegration: 'Intégration de l’agenda',
      diaryDesc: 'Connectez votre système de gestion de garage pour que l’agent puisse vérifier les disponibilités ou confirmer des réservations pendant les appels.',
      system: 'Système',
      ghInstance: 'Instance Garage Hive',
      ghInstancePlaceholder: 'Votre instance fournie par Garage Hive',
      ghInstanceHint: 'Saisissez le nom exact de l’instance fourni par Garage Hive. Utilisez uniquement des lettres, des chiffres, des tirets, des traits de soulignement ou des points.',
      ghApiKey: 'Clé API Garage Hive',
      ghApiKeyHint: 'Stockée en toute sécurité et visible uniquement par vous pendant la modification.',
      customerId: 'ID client',
      customerIdHint: 'Votre identifiant client Garage Hive unique pour cette agence.',
      locationId: 'ID d’emplacement',
      locationIdHint: 'Indiquez l’identifiant exact de l’emplacement ou de l’agence Garage Hive dans lequel l’agent doit réserver.',
      instance: 'Instance',
      ghApiKeyShort: 'Clé API',
      noDiaryIntegration: 'Aucune intégration d’agenda configurée.',
      crmIntegration: 'Intégration CRM',
      crmDesc: 'Connectez HubSpot pour que chaque appel entrant crée automatiquement un contact et un fil de conversation dans votre boîte de réception Conversations.',
      enableHubspot: 'Activer l’intégration CRM HubSpot',
      hubspotSetupTitle: 'Comment configurer l’intégration HubSpot',
      hubspotStep1: 'Connectez-vous à HubSpot → Paramètres (icône d’engrenage en haut à droite).',
      hubspotStep2a: 'Allez dans ',
      hubspotStep2b: 'Intégrations → Applications héritées',
      hubspotStep2c: ' → créez ou ouvrez votre application.',
      hubspotStep3a: 'Sous Scopes, activez : ',
      hubspotStep3b: '.',
      hubspotStep4a: 'Copiez le jeton (commence par ',
      hubspotStep4b: ') et collez-le ci-dessous.',
      hubspotStep5: 'Vous pouvez éventuellement saisir votre ID de propriétaire HubSpot pour attribuer les tickets et les appels à un utilisateur spécifique. Laissez vide pour enregistrer sans propriétaire.',
      hubspotApiToken: 'Jeton API HubSpot',
      hubspotInboxEmail: 'Adresse e-mail de la boîte de réception (facultatif)',
      hubspotInboxHint: 'Lorsqu’elle est définie, chaque appel apparaîtra également comme un nouveau message dans votre boîte de réception Conversations HubSpot — tout comme une soumission de formulaire.',
      hubspotOwnerId: 'ID de propriétaire HubSpot (facultatif)',
      hubspotOwnerIdPlaceholder: 'ex. 11349275740',
      hubspotOwnerHint: 'Attribuez les enregistrements d’appels à un utilisateur HubSpot spécifique. Laissez vide pour enregistrer sans propriétaire.',
      privateAppToken: 'Jeton d’application privée',
      inboxEmail: 'E-mail de la boîte de réception',
      ownerId: 'ID de propriétaire',
      saving: 'Enregistrement…',
      saveConfiguration: 'Enregistrer la configuration',
      failedToLoad: 'Échec du chargement de la configuration. ',
      tryAgainLater: 'Veuillez réessayer plus tard.',
      reviewChanges: 'Vérifiez vos modifications, puis enregistrez pour les appliquer à votre agent.',
      configSaved: ['Configuration enregistrée', 'Modifications appliquées à votre agent.'] as const,
      saveFailed: 'Échec de l’enregistrement',
      saveFailedFallback: 'Échec de l’enregistrement de la configuration. Veuillez réessayer.',
      selectPagesThenPublish: 'Sélectionnez les pages à inclure, puis publiez la base de connaissances.',
      noCrawlablePages: 'Aucune page explorable n’a été trouvée. Essayez une autre URL de départ.',
      crawlFailedFallback: 'Échec de l’exploration de ce site web. Veuillez réessayer.',
      knowledgeUpdatedFrom: (n: number) => `Base de connaissances mise à jour à partir de ${n} page${n === 1 ? '' : 's'}.`,
      publishFailedFallback: 'Échec de la publication des pages sélectionnées. Veuillez réessayer.',
      docAddedToKb: (isPrice: boolean) => `${isPrice ? 'Grille tarifaire' : 'Document'} ajouté à la base de connaissances.`,
      uploadFailed: 'Échec du téléversement',
      uploadFailedFallback: 'Échec du téléversement de ce fichier. Veuillez réessayer.',
      removedFromKb: 'Retiré de la base de connaissances.',
      removeFailed: 'Échec de la suppression',
      removeFailedFallback: 'Échec de la suppression de ce document. Veuillez réessayer.',
      enterWebsiteBeforeScan: 'Saisissez une URL de site web avant d’analyser.',
      selectAtLeastOnePage: 'Sélectionnez au moins une page à inclure.',
      scanBeforePublish: 'Analysez un site web avant de publier la base de connaissances.',
      noScanData: 'Aucune donnée d’analyse de site web disponible.',
      populated: (fields: string, hoursNote: string) => `✓ Renseigné : ${fields}. ${hoursNote}`,
      couldNotParseHours: 'Remarque : impossible d’analyser le format des horaires d’ouverture.',
      noNewInfo: 'Aucune nouvelle information trouvée dans l’analyse, ou les champs sont déjà remplis. Consultez la console pour plus de détails.',
      enterEmail: 'Veuillez saisir une adresse e-mail.',
      enterValidEmail: 'Veuillez saisir une adresse e-mail valide.',
      emailAlready: 'Cet e-mail figure déjà dans la liste de notifications.',
      voicePreviewFailed: 'Échec de la lecture de l’aperçu vocal',
      voicePreviewFailedRetry: 'Échec de la lecture de l’aperçu vocal. Veuillez réessayer.',
    },
  }[lang];
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
  const queryClient = useQueryClient();

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
      queryClient.setQueryData(['agent-config', garageId], data);
      setFormState(cloneConfiguration(data.configuration));
      setKnowledgeBase(data.knowledgeBase ?? []);
      setIsEditing(false);
      setFeedback(null);
      toast.success(c.configSaved[0], c.configSaved[1]);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : c.saveFailedFallback;
      setFeedback(null);
      toast.error(c.saveFailed, message);
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
          ? c.selectPagesThenPublish
          : c.noCrawlablePages,
      );
    },
    onError: (error: unknown) => {
      setLastScanUrl(null);
      setDiscoveredPages([]);
      setSelectedPageUrls([]);
      const message =
        error instanceof Error ? error.message : c.crawlFailedFallback;
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
      setFeedback(c.knowledgeUpdatedFrom(data.processedPages));
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : c.publishFailedFallback;
      setFeedback(message);
    },
  });

  const uploadDocMutation = useMutation({
    mutationFn: (payload: { file: File; kind: 'document' | 'price-list' }) =>
      uploadKnowledgeDocument(payload.file, payload.kind, garageId ?? undefined),
    onSuccess: (data, variables) => {
      setKnowledgeBase(data.knowledgeBase ?? []);
      setFeedback(c.docAddedToKb(variables.kind === 'price-list'));
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : c.uploadFailedFallback;
      toast.error(c.uploadFailed, message);
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: (uploadId: string) => deleteKnowledgeDocument(uploadId, garageId ?? undefined),
    onSuccess: (data) => {
      setKnowledgeBase(data.knowledgeBase ?? []);
      setFeedback(c.removedFromKb);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : c.removeFailedFallback;
      toast.error(c.removeFailed, message);
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
      setFeedback(c.enterWebsiteBeforeScan);
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
      setFeedback(c.selectAtLeastOnePage);
      return;
    }

    const baseUrlCandidate = lastScanUrl ?? formState.websiteUrl.trim();
    if (!baseUrlCandidate) {
      setFeedback(c.scanBeforePublish);
      return;
    }

    setFeedback(null);
    websiteIngestMutation.mutate({ url: baseUrlCandidate, selectedUrls: selectedPageUrls });
  };

  const handleAutoPopulateFromScan = () => {
    if (!discoveredPages.length) {
      setFeedback(c.noScanData);
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
      setFeedback(c.populated(updatedFields, allHours.length > 0 && !updates.weeklyOpeningHours ? c.couldNotParseHours : ''));
    } else {
      setFeedback(c.noNewInfo);
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
      return lang === 'fr'
        ? 'Ce garage utilise un agent GarageHive mais l’intégration de l’agenda est réglée sur « Non connecté ». L’agent se contentera de prendre un message au lieu de réserver. Réglez l’intégration sur Garage Hive et ajoutez les identifiants.'
        : 'This garage is using a GarageHive agent but the Diary Integration is set to "Not connected". The agent will fall back to taking a message instead of booking. Set the integration to Garage Hive and add credentials.';
    }
    const { customerId, apiKey } = formState.garageHiveSettings ?? {};
    if (!customerId?.trim() || !apiKey?.trim()) {
      return lang === 'fr'
        ? 'GarageHive est sélectionné comme intégration mais l’ID client ou la clé API est manquant. L’agent se contentera de prendre un message au lieu de réserver. Complétez les identifiants ci-dessous.'
        : 'GarageHive is selected as the integration but Customer ID or API key is missing. The agent will fall back to taking a message instead of booking. Complete the credentials below.';
    }
    return null;
  }, [formState.agentScript, formState.integrationProvider, formState.garageHiveSettings, lang]);

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

      const audioBlob = await generateVoicePreview(voiceId, garageId ?? undefined, lang);
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setPlayingVoice(null);
        URL.revokeObjectURL(audioUrl);
      };

      audio.onerror = () => {
        setPlayingVoice(null);
        setFeedback(c.voicePreviewFailed);
        URL.revokeObjectURL(audioUrl);
      };

      setAudioElement(audio);
      await audio.play();
    } catch (error) {
      console.error('Voice preview error:', error);
      setPlayingVoice(null);
      setFeedback(c.voicePreviewFailedRetry);
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
      setFeedback(c.enterEmail);
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      setFeedback(c.enterValidEmail);
      return;
    }

    if (formState.notificationEmails.includes(trimmed)) {
      setFeedback(c.emailAlready);
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
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-700">
        {c.noGarage}
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700">
        {c.loading}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{c.pageTitle}</h1>
          <p className="text-sm text-slate-600">
            {c.pageSubtitle}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:text-slate-900 disabled:opacity-60"
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
            {isEditing ? c.cancel : c.edit}
          </button>
        </div>
      </header>

      {ghMisconfigWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <span className="font-semibold">{c.configWarningLabel}</span>
          {ghMisconfigWarning}
        </div>
      )}

      {feedback ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {feedback}
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.branchDetails}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.branchDetailsDesc}
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.branchName}</span>
              <input
                type="text"
                value={formState.branchName}
                onChange={handleInputChange('branchName')}
                disabled={!isEditing || mutation.isPending}
                required
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.branchPhone}</span>
              <input
                type="text"
                value={formState.phoneNumber}
                onChange={handleInputChange('phoneNumber')}
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.rmNumber}</span>
              <input
                type="text"
                value={twilioNumber}
                readOnly
                placeholder={c.notAssignedYet}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 focus:border-slate-300 focus:outline-none"
              />
              <span className="text-[11px] text-slate-500">{c.managedByStaff}</span>
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.primaryEmail}</span>
              <input
                type="email"
                value={formState.emailAddress}
                onChange={handleInputChange('emailAddress')}
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.websiteUrl}</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={formState.websiteUrl}
                  onChange={handleInputChange('websiteUrl')}
                  disabled={!isEditing || mutation.isPending || scanningSite || publishingKnowledge}
                  className="w-full flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="https://"
                />
                {isEditing ? (
                  <button
                    type="button"
                    onClick={handleWebsiteScan}
                    disabled={
                      mutation.isPending || scanningSite || publishingKnowledge || !formState.websiteUrl
                    }
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 transition hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {scanningSite ? c.scanning : c.scanSite}
                  </button>
                ) : null}
              </div>
            </label>
          </div>

          <label className="mt-5 flex flex-col gap-2 text-sm text-slate-700">
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.branchAddress}</span>
            <textarea
              value={formState.branchAddress}
              onChange={handleInputChange('branchAddress')}
              disabled={!isEditing || mutation.isPending}
              rows={3}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          
          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.notificationEmails}</span>
              <p className="text-xs text-slate-600">
                {c.notificationEmailsDesc}
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
                    placeholder={c.addEmailPlaceholder}
                    className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={handleAddNotificationEmail}
                    disabled={mutation.isPending || !newNotificationEmail.trim()}
                    className="rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-900 transition hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {c.add}
                  </button>
                </div>
              ) : null}
              
              {formState.notificationEmails.length > 0 ? (
                <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {formState.notificationEmails.map((email) => (
                    <div
                      key={email}
                      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                    >
                      <span className="text-sm text-slate-900">{email}</span>
                      {isEditing ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveNotificationEmail(email)}
                          disabled={mutation.isPending}
                          className="text-xs text-rose-400 transition hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {c.remove}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  {isEditing ? c.noEmailsEditing : c.noEmailsView}
                </div>
              )}
            </label>
          </div>
        </section>

        {formState.agentType === 'assist' && (
          <>
            <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
              <h2 className="text-lg font-semibold text-slate-900">{c.bookingPreferences}</h2>
              <p className="mt-1 text-sm text-slate-600">
                {c.bookingPreferencesDesc}
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <div className="flex-1 min-w-[12rem]">
                  <span className="text-sm font-medium text-slate-700">
                    {c.allowBookings}
                  </span>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {c.allowBookingsDesc}
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
                      ? 'border-emerald-500 bg-emerald-100 text-emerald-700'
                      : 'border-slate-300 bg-white text-slate-800'
                  } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  <span
                    className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                      formState.allowBookings ? 'bg-emerald-500/70' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`absolute h-4 w-4 rounded-full bg-white transition-transform ${
                        formState.allowBookings ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </span>
                  {formState.allowBookings ? c.enabled : c.disabled}
                </button>
              </div>

              {formState.allowBookings && (
                <div className="mt-6 rounded-lg border border-slate-300 bg-white p-4">
                  <label htmlFor="bookingLeadTime" className="block text-sm font-medium text-slate-700">
                    {c.bookingLeadTime}
                  </label>
                  <p className="mt-1 text-xs text-slate-600">
                    {c.bookingLeadTimeDesc}
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
                      className="block w-32 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-sm text-slate-600">{c.days}</span>
                  </div>
                  <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
                    <p className="text-xs text-sky-700">
                      {formState.bookingLeadTimeDays === 1
                        ? c.leadTimeToday
                        : c.leadTimeAdvance(formState.bookingLeadTimeDays)}
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
              <h2 className="text-lg font-semibold text-slate-900">{c.smsBookingLinks}</h2>
              <p className="mt-1 text-sm text-slate-600">
                {c.smsBookingLinksDesc1}<strong>{c.websiteUrlBold}</strong>{c.smsBookingLinksDesc2}
              </p>

            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
              <p className="text-xs text-sky-700">
                <strong>{c.tipLabel}</strong>{c.smsTip}
              </p>
            </div>

            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs text-amber-700">
                <strong>{c.billingNoteLabel}</strong>{c.smsBillingNote}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-slate-700">
                {c.enableSms}
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
                    ? 'border-emerald-500 bg-emerald-100 text-emerald-700'
                    : 'border-slate-300 bg-white text-slate-800'
                } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span
                  className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                    formState.enableSmsBookingLinks ? 'bg-emerald-500/70' : 'bg-slate-200'
                  }`}
                >
                  <span
                    className={`absolute h-4 w-4 rounded-full bg-white transition-transform ${
                      formState.enableSmsBookingLinks ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </span>
                {formState.enableSmsBookingLinks ? c.enabled : c.disabled}
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

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{c.knowledgeBase}</h2>
              <p className="text-sm text-slate-600">
                {c.knowledgeBaseDesc}
              </p>
            </div>
            <div className="text-xs text-slate-500">
              {knowledgeUpdatedAt
                ? c.lastUpdated(new Date(knowledgeUpdatedAt).toLocaleString())
                : c.notPublishedYet}
            </div>
          </div>

          {scanningSite ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
              {c.scanningWebsite}
            </div>
          ) : null}

          {discoveredPages.length ? (
            <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {c.discoveredPages(discoveredPages.length)}
                  </p>
                  <p className="text-xs text-slate-600">
                    {c.tickPages}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    onClick={handleAutoPopulateFromScan}
                    disabled={publishingKnowledge}
                    className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {c.autoFill}
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllPages}
                    disabled={publishingKnowledge || allPagesSelected}
                    className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1 font-medium text-slate-800 transition hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {c.selectAll}
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAllPages}
                    disabled={publishingKnowledge || selectedPageUrls.length === 0}
                    className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1 font-medium text-slate-800 transition hover:border-rose-500 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {c.clear}
                  </button>
                </div>
              </div>

              <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {discoveredPages.map((page) => {
                  const isChecked = selectedPageUrls.includes(page.url);
                  return (
                    <label
                      key={page.url}
                      className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border border-slate-300 bg-white text-sky-500 focus:ring-sky-500"
                        checked={isChecked}
                        onChange={() => togglePageSelection(page.url)}
                        disabled={publishingKnowledge}
                      />
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <span className="text-sm font-semibold text-slate-900">
                            {page.title?.trim() || c.untitledPage}
                          </span>
                          <span className="text-xs text-slate-500 break-all">
                            {page.url}
                          </span>
                        </div>
                        {page.description ? (
                          <p className="text-xs text-slate-700">{page.description}</p>
                        ) : null}
                        {page.snippet ? (
                          <p className="text-xs text-slate-600">{page.snippet}</p>
                        ) : null}
                        <div className="flex flex-wrap gap-2 text-[11px] text-slate-600">
                          {page.chunkCount ? (
                            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                              {c.sectionsBadge(page.chunkCount)}
                            </span>
                          ) : null}
                          {page.phoneNumbers.length ? (
                            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                              {c.phonesBadge(page.phoneNumbers.length)}
                            </span>
                          ) : null}
                          {page.emails.length ? (
                            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                              {c.emailsBadge(page.emails.length)}
                            </span>
                          ) : null}
                          {page.hours.length ? (
                            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                              {c.hoursRowsBadge(page.hours.length)}
                            </span>
                          ) : null}
                          {page.address ? (
                            <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5">
                              {c.addressFound}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-600">
                  {c.selectedPages(selectedPageUrls.length)}
                </span>
                <button
                  type="button"
                  onClick={handleApplySelection}
                  disabled={publishingKnowledge || selectedPageUrls.length === 0}
                  className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {publishingKnowledge
                    ? c.publishing
                    : c.publishSelected(selectedPageUrls.length)}
                </button>
              </div>
            </div>
          ) : null}

          {!discoveredPages.length && !scanningSite ? (
            <p className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
              {c.startScanHint}
            </p>
          ) : null}

          {/* Document & price-list uploads — parsed, chunked, and retrieved per-call (no prompt bloat). */}
          <div className="mt-6 border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">{c.docsAndPriceLists}</h3>
            <p className="mt-1 text-xs text-slate-600">
              {c.docsDesc}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800 transition hover:border-sky-500 hover:text-sky-700">
                {uploadDocMutation.isPending ? c.uploading : c.uploadDocument}
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.txt,.md"
                  className="hidden"
                  disabled={uploadDocMutation.isPending}
                  onChange={handleDocUpload('document')}
                />
              </label>
              {formState.agentType === 'assist' && showPriceUpload ? (
                <label className="cursor-pointer rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100">
                  {uploadDocMutation.isPending ? c.uploading : c.uploadPriceList}
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
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={showPriceUpload}
                    onChange={(event) => handleTogglePrices(event.target.checked)}
                    disabled={deleteDocMutation.isPending}
                    className="h-4 w-4 rounded border-slate-300 bg-slate-50 accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-slate-800">{c.givePrices}</span>
                </label>
                <p className="mt-1.5 pl-7 text-[11px] text-slate-500">
                  {showPriceUpload
                    ? c.pricesOn
                    : c.pricesOff}
                </p>
              </div>
            ) : null}
            {uploadedDocs.length ? (
              <ul className="mt-4 space-y-2">
                {uploadedDocs.map((doc) => (
                  <li
                    key={doc.uploadId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-800">{doc.fileName}</p>
                      <p className="text-[11px] text-slate-500">
                        {doc.kind === 'price-list' ? c.priceListLabel : c.documentLabel} · {c.docSections(doc.chunks)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteDocMutation.mutate(doc.uploadId)}
                      disabled={deleteDocMutation.isPending}
                      className="shrink-0 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-rose-500 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {c.remove}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-500">{c.noDocs}</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.availabilityMessaging}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.availabilityDesc}
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.weeklyHours}</span>
              {isEditing ? (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="hidden grid-cols-[minmax(110px,0.4fr)_repeat(2,minmax(0,1fr))_auto] items-center gap-3 px-3 text-xs uppercase tracking-wide text-slate-500 md:grid">
                    <span>{c.day}</span>
                    <span>{c.opens}</span>
                    <span>{c.closes}</span>
                    <span>{c.status}</span>
                  </div>
                  {WEEKDAY_ORDER.map((day) => {
                    const hours = formState.weeklyOpeningHours[day];
                    return (
                      <div
                        key={day}
                        className="grid grid-cols-2 md:grid-cols-[minmax(110px,0.4fr)_repeat(2,minmax(0,1fr))_auto] items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                      >
                        <span className="col-span-2 text-sm font-medium text-slate-900 md:col-span-1">{DAY_LABELS[day]}</span>
                        <input
                          type="time"
                          aria-label={c.openingTimeAria(DAY_LABELS[day])}
                          value={hours.open ?? ''}
                          onChange={handleHoursChange(day, 'open')}
                          disabled={!isEditing || mutation.isPending || hours.closed}
                          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <input
                          type="time"
                          aria-label={c.closingTimeAria(DAY_LABELS[day])}
                          value={hours.close ?? ''}
                          onChange={handleHoursChange(day, 'close')}
                          disabled={!isEditing || mutation.isPending || hours.closed}
                          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => handleDayClosedToggle(day)}
                          disabled={!isEditing || mutation.isPending}
                          className={`col-span-2 md:col-span-1 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                            hours.closed
                              ? 'border-rose-500/70 bg-rose-500/10 text-rose-200 hover:border-rose-400 hover:text-rose-100'
                              : 'border-emerald-500/70 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:text-emerald-700'
                          } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                        >
                          {hours.closed ? c.closed : c.open}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {WEEKDAY_ORDER.map((day) => {
                    const hours = formState.weeklyOpeningHours[day];
                    return (
                      <div key={day} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-slate-600">{DAY_LABELS[day]}</span>
                        <span className="text-slate-900">{describeHoursRange(hours, lang)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-slate-500">
                {c.hoursHint}
              </p>
            </div>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.holidayClosures}</span>
              <textarea
                value={formState.holidayClosures}
                onChange={handleInputChange('holidayClosures')}
                disabled={!isEditing || mutation.isPending}
                rows={4}
                placeholder={c.holidayPlaceholder}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.greetingLine}</span>
              <input
                type="text"
                value={formState.greetingLine}
                onChange={handleInputChange('greetingLine')}
                disabled={!isEditing || mutation.isPending}
                placeholder={c.greetingPlaceholder}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.transferNumber}</span>
              <input
                type="text"
                value={formState.transferNumber}
                onChange={handleInputChange('transferNumber')}
                disabled={!isEditing || mutation.isPending}
                placeholder={c.transferPlaceholder}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="text-xs text-slate-500">{c.transferHint}</span>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.toneBookingRules}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.toneBookingDesc}
          </p>

          <div className="mt-6">
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.voice}</span>
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
                        : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      className={`w-full text-left mb-3 ${
                        isSelected ? 'text-slate-900' : 'text-slate-700 hover:text-slate-800'
                      } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                      onClick={() => handleVoiceChange(option.value)}
                      disabled={!isEditing || mutation.isPending}
                    >
                      <div className="text-sm font-semibold">{option.label}</div>
                      <div className="mt-1 text-xs text-slate-600">{option.description}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePlayVoice(option.value)}
                      disabled={isPlaying || !formState.greetingLine}
                      className={`w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
                        isPlaying
                          ? 'bg-purple-500 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-900'
                      } ${!formState.greetingLine ? 'cursor-not-allowed opacity-40' : ''}`}
                      title={!formState.greetingLine ? c.addGreetingToPreview : c.playPreview}
                    >
                      {isPlaying ? (
                        <>
                          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" />
                          </svg>
                          <span>{c.playing}</span>
                        </>
                      ) : (
                        <>
                          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" />
                          </svg>
                          <span>{c.previewVoice}</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {!formState.greetingLine && (
              <p className="mt-2 text-xs text-amber-600">
                {c.greetingHint}
              </p>
            )}
          </div>

          <div className="mt-8">
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.tonePreference}</span>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              {toneOptions.map((option) => {
                const isSelected = formState.tonePreference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                      isSelected
                        ? 'border-sky-500 bg-sky-50 text-slate-900'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:text-slate-800'
                    } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                    onClick={() => {
                      if (!isEditing || mutation.isPending) return;
                      handleToneChange(option.value);
                    }}
                    disabled={!isEditing || mutation.isPending}
                  >
                    <div className="text-sm font-semibold">{option.label}</div>
                    <div className="mt-1 text-xs text-slate-600">{option.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Response timing / interruption sensitivity removed from the UI — endpointing
              (dynamic) and interruption sensitivity are now hardcoded in every agent. */}

          <div className="mt-6 flex flex-col gap-3 text-sm text-slate-700">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              <span className="inline-flex items-center gap-2">
                {c.allowFastFitTitle}
                <span
                  className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] text-slate-700 transition focus-visible:border-slate-300 focus-visible:text-slate-900 focus-visible:outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label={c.allowFastFitAria}
                >
                  i
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-48 -translate-x-1/2 translate-y-2 rounded-md bg-slate-100 px-3 py-2 text-left text-[11px] font-normal text-slate-900 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                    {c.allowFastFitTooltip}
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
                  ? 'border-emerald-500 bg-emerald-100 text-emerald-700'
                  : 'border-slate-300 bg-white text-slate-800'
              } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <span
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                  formState.allowFastFitOnly ? 'bg-emerald-500/70' : 'bg-slate-200'
                }`}
              >
                <span
                  className={`absolute h-4 w-4 rounded-full bg-white transition-transform ${
                    formState.allowFastFitOnly ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </span>
              {formState.allowFastFitOnly ? c.yes : c.no}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.dropOffBookings}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.dropOffDesc}
          </p>

          <div className="mt-6 flex flex-col gap-3 text-sm text-slate-700">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              <span className="inline-flex items-center gap-2">
                {c.enableDropOff}
                <span
                  className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] text-slate-700 transition focus-visible:border-slate-300 focus-visible:text-slate-900 focus-visible:outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label={c.enableDropOffAria}
                >
                  i
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-48 -translate-x-1/2 translate-y-2 rounded-md bg-slate-100 px-3 py-2 text-left text-[11px] font-normal text-slate-900 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                    {c.enableDropOffTooltip}
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
                  ? 'border-emerald-500 bg-emerald-100 text-emerald-700'
                  : 'border-slate-300 bg-white text-slate-800'
              } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <span
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                  formState.enableDropOffBookings ? 'bg-emerald-500/70' : 'bg-slate-200'
                }`}
              >
                <span
                  className={`absolute h-4 w-4 rounded-full bg-white transition-transform ${
                    formState.enableDropOffBookings ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </span>
              {formState.enableDropOffBookings ? c.enabled : c.disabled}
            </button>
          </div>

          {formState.enableDropOffBookings && (
            <>
              <div className="mt-6">
                <label className="flex flex-col gap-2 text-sm text-slate-700">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    <span className="inline-flex items-center gap-2">
                      {c.dropOffMessage}
                      <span
                        className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] text-slate-700 transition focus-visible:border-slate-300 focus-visible:text-slate-900 focus-visible:outline-none"
                        tabIndex={0}
                        role="button"
                        aria-label={c.dropOffMessageAria}
                      >
                        i
                        <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-64 -translate-x-1/2 translate-y-2 rounded-md bg-slate-100 px-3 py-2 text-left text-[11px] font-normal text-slate-900 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                          {c.dropOffMessageTooltip}
                        </span>
                      </span>
                    </span>
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={formState.dropOffMessage || ''}
                      onChange={(e) => setFormState((prev) => ({ ...prev, dropOffMessage: e.target.value }))}
                      placeholder={c.dropOffMessagePlaceholder}
                      disabled={mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  ) : (
                    <span className="text-sm text-slate-800">{formState.dropOffMessage || c.notSet}</span>
                  )}
                </label>
              </div>

              <div className="mt-6">
                <label className="flex flex-col gap-2 text-sm text-slate-700">
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    <span className="inline-flex items-center gap-2">
                      {c.excludedServices}
                      <span
                        className="group relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] text-slate-700 transition focus-visible:border-slate-300 focus-visible:text-slate-900 focus-visible:outline-none"
                        tabIndex={0}
                        role="button"
                        aria-label={c.excludedServicesAria}
                      >
                        i
                        <span className="pointer-events-none absolute left-1/2 top-full z-20 hidden w-64 -translate-x-1/2 translate-y-2 rounded-md bg-slate-100 px-3 py-2 text-left text-[11px] font-normal text-slate-900 shadow-lg group-hover:block group-focus:block group-focus-visible:block">
                          {c.excludedServicesTooltip}
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
                      placeholder={c.excludedPlaceholder}
                      disabled={mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  ) : (
                    <span className="text-sm text-slate-800">
                      {(formState.dropOffExcludeServices || []).join(', ') || c.none}
                    </span>
                  )}
                </label>
              </div>
            </>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.agentType}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.agentTypeDesc}
          </p>

          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.agent}</span>
              <select
                value={formState.agentType}
                onChange={(event) =>
                  setFormState((state) => ({
                    ...state,
                    agentType: event.target.value as AgentType,
                  }))
                }
                disabled={!isEditing || mutation.isPending || !canEditAgentType}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
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
                <span className="text-xs text-amber-600">
                  {c.onlyStaffAgentType}
                </span>
              )}
            </label>
          </div>

          <div className="mt-6">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.agentVersion}</span>
              <select
                value={formState.agentScript}
                onChange={(event) =>
                  setFormState((state) => ({
                    ...state,
                    agentScript: event.target.value as 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent' | 'bookar-agent',
                  }))
                }
                disabled={!isEditing || mutation.isPending || !canEditAgentType}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
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
              <span className="text-xs text-slate-600">
                {c.agentScriptHint}
              </span>
              {!canEditAgentType && (
                <span className="text-xs text-amber-600">
                  {c.onlyStaffAgentVersion}
                </span>
              )}
            </label>
          </div>
        </section>

        {formState.agentScript === 'tyresoft-agent' && canEditAgentType && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
            <h2 className="text-lg font-semibold text-slate-900">{c.tyresoftConfig}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {c.tyresoftDesc}
            </p>
            <div className="mt-6">
              {isEditing ? (
                <div className="grid gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.workspace}</span>
                    <input
                      type="text"
                      placeholder={c.workspacePlaceholder}
                      value={formState.tyresoftSettings.tsWorkspace}
                      onChange={handleTyresoftSettingsChange('tsWorkspace')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.username}</span>
                    <input
                      type="text"
                      value={formState.tyresoftSettings.tsUsername}
                      onChange={handleTyresoftSettingsChange('tsUsername')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.password}</span>
                    <input
                      type="password"
                      value={formState.tyresoftSettings.tsPassword}
                      onChange={handleTyresoftSettingsChange('tsPassword')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.apiKey}</span>
                    <input
                      type="password"
                      value={formState.tyresoftSettings.tsApiKey}
                      onChange={handleTyresoftSettingsChange('tsApiKey')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.depotId}</span>
                    <input
                      type="text"
                      placeholder={c.depotPlaceholder}
                      value={formState.tyresoftSettings.tsDepotId}
                      onChange={handleTyresoftSettingsChange('tsDepotId')}
                      disabled={!isEditing || mutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.workspace}</span>
                    <div className="text-slate-900">{formState.tyresoftSettings.tsWorkspace || c.notSet}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.username}</span>
                    <div className="text-slate-900">{formState.tyresoftSettings.tsUsername || c.notSet}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.password}</span>
                    <div className="text-slate-900">{maskSecretValue(formState.tyresoftSettings.tsPassword, lang)}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.apiKey}</span>
                    <div className="text-slate-900">{maskSecretValue(formState.tyresoftSettings.tsApiKey, lang)}</div>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.depotId}</span>
                    <div className="text-slate-900">{formState.tyresoftSettings.tsDepotId || c.notSet}</div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.diaryIntegration}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.diaryDesc}
          </p>

          <div className="mt-6 space-y-5">
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              <span className="text-xs uppercase tracking-wide text-slate-500">{c.system}</span>
              <select
                value={formState.integrationProvider}
                onChange={(event) =>
                  handleIntegrationProviderChange(event.target.value as IntegrationProvider)
                }
                disabled={!isEditing || mutation.isPending}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
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
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.ghInstance}</span>
                    <input
                      type="text"
                      placeholder={c.ghInstancePlaceholder}
                      value={formState.garageHiveSettings.instanceUrl}
                      onChange={handleGarageHiveSettingsChange('instanceUrl')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      {c.ghInstanceHint}
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.ghApiKey}</span>
                    <input
                      type="password"
                      value={formState.garageHiveSettings.apiKey}
                      onChange={handleGarageHiveSettingsChange('apiKey')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      {c.ghApiKeyHint}
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.customerId}</span>
                    <input
                      type="text"
                      value={formState.garageHiveSettings.customerId}
                      onChange={handleGarageHiveSettingsChange('customerId')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      {c.customerIdHint}
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-700">
                    <span className="text-xs uppercase tracking-wide text-slate-500">{c.locationId}</span>
                    <input
                      type="text"
                      value={formState.garageHiveSettings.locationId}
                      onChange={handleGarageHiveSettingsChange('locationId')}
                      disabled={!isEditing || mutation.isPending}
                      required={formState.integrationProvider === 'garage_hive'}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span className="text-xs text-slate-500">
                      {c.locationIdHint}
                    </span>
                  </label>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.system}</span>
                      <div className="text-slate-900">Garage Hive</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.instance}</span>
                      <div className="text-slate-900">
                        {formState.garageHiveSettings.instanceUrl || c.notSet}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.ghApiKeyShort}</span>
                      <div className="text-slate-900">
                        {maskSecretValue(formState.garageHiveSettings.apiKey, lang)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.customerId}</span>
                      <div className="text-slate-900">
                        {formState.garageHiveSettings.customerId || c.notSet}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.locationId}</span>
                      <div className="text-slate-900">
                        {formState.garageHiveSettings.locationId || c.notSet}
                      </div>
                    </div>
                  </div>
                </div>
              )
            ) : (
              !isEditing && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  {c.noDiaryIntegration}
                </div>
              )
            )}
          </div>
        </section>

        {/* CRM Integration — HubSpot */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-lg shadow-slate-200/60">
          <h2 className="text-lg font-semibold text-slate-900">{c.crmIntegration}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {c.crmDesc}
          </p>
          <div className="mt-6 space-y-5">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={formState.hubspotSettings?.enabled === true}
                onChange={handleHubspotSettingsChange('enabled')}
                disabled={!isEditing || mutation.isPending}
                className="h-4 w-4 rounded border-slate-300 bg-slate-100 text-sky-500 focus:ring-sky-500 disabled:cursor-not-allowed"
              />
              <span className="text-sm text-slate-700">{c.enableHubspot}</span>
            </label>

            {formState.hubspotSettings?.enabled && (
              isEditing ? (
                <div className="flex flex-col gap-5">
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-slate-700">
                    <p className="mb-3 font-medium text-sky-700">{c.hubspotSetupTitle}</p>
                    <ol className="flex flex-col gap-2 text-slate-600 list-decimal list-inside">
                      <li>{c.hubspotStep1}</li>
                      <li>{c.hubspotStep2a}<span className="text-slate-800">{c.hubspotStep2b}</span>{c.hubspotStep2c}</li>
                      <li>{c.hubspotStep3a}<code className="text-sky-700">crm.objects.contacts.read</code>, <code className="text-sky-700">crm.objects.contacts.write</code>, <code className="text-sky-700">tickets</code>, <code className="text-sky-700">crm.objects.calls.write</code>{c.hubspotStep3b}</li>
                      <li>{c.hubspotStep4a}<code className="text-sky-700">pat-</code>{c.hubspotStep4b}</li>
                      <li>{c.hubspotStep5}</li>
                    </ol>
                  </div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <label className="flex flex-col gap-2 text-sm text-slate-700 md:col-span-2">
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.hubspotApiToken}</span>
                      <input
                        type="password"
                        placeholder="pat-na1-..."
                        value={formState.hubspotSettings?.apiToken ?? ''}
                        onChange={handleHubspotSettingsChange('apiToken')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="flex flex-col gap-2 text-sm text-slate-700 md:col-span-2">
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.hubspotInboxEmail}</span>
                      <input
                        type="email"
                        placeholder="support@12345.hs-inbox.com"
                        value={formState.hubspotSettings?.inboxEmail ?? ''}
                        onChange={handleHubspotSettingsChange('inboxEmail')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span className="text-xs text-slate-500">{c.hubspotInboxHint}</span>
                    </label>
                    <label className="flex flex-col gap-2 text-sm text-slate-700">
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.hubspotOwnerId}</span>
                      <input
                        type="text"
                        placeholder={c.hubspotOwnerIdPlaceholder}
                        value={formState.hubspotSettings?.ownerId ?? ''}
                        onChange={handleHubspotSettingsChange('ownerId')}
                        disabled={!isEditing || mutation.isPending}
                        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <span className="text-xs text-slate-500">{c.hubspotOwnerHint}</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.privateAppToken}</span>
                      <div className="text-slate-900">{formState.hubspotSettings?.apiToken ? '••••••••••••••••' : c.notSet}</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.inboxEmail}</span>
                      <div className="text-slate-900">{formState.hubspotSettings?.inboxEmail || c.notSet}</div>
                    </div>
                    <div>
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.ownerId}</span>
                      <div className="text-slate-900">{formState.hubspotSettings?.ownerId || c.notSet}</div>
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
            {mutation.isPending ? c.saving : c.saveConfiguration}
          </button>
        </div>
      </form>

      {query.isError ? (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {c.failedToLoad}
          {query.error instanceof Error ? query.error.message : c.tryAgainLater}
        </div>
      ) : null}

      <StickySaveBar
        visible={isEditing}
        saving={mutation.isPending}
        summary={c.reviewChanges}
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

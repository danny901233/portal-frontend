'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChangeEvent, FormEvent } from 'react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  discoverWebsitePages,
  fetchAgentConfiguration,
  ingestWebsiteKnowledge,
  updateAgentConfiguration,
} from '../lib/api';
import { getGarageId, isReceptionMateStaff } from '../lib/auth';
import {
  createEmptyWeeklyOpeningHours,
  WEEKDAY_ORDER,
} from '../types';
import type {
  AgentConfiguration,
  AgentKnowledgeDocument,
  AgentType,
  DayOfWeek,
  IntegrationProvider,
  ResponseSpeed,
  TonePreference,
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

const createEmptyConfiguration = (): AgentConfiguration => ({
  branchName: '',
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
  callSummaryEmail: '',
  notificationEmails: [],
  integrationProvider: 'none',
  garageHiveSettings: createEmptyGarageHiveSettings(),
  agentType: 'assist',
});

const cloneConfiguration = (config: AgentConfiguration): AgentConfiguration => ({
  ...config,
  weeklyOpeningHours: cloneWeeklyOpeningHours(config.weeklyOpeningHours),
  garageHiveSettings: cloneGarageHiveSettings(config.garageHiveSettings),
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

const maskSecretValue = (value: string) => {
  if (!value) {
    return 'Not set';
  }
  if (value.length <= 4) {
    return 'Stored';
  }
  return `${value.slice(0, 4)}****`;
};

const responseSpeedOptions: { value: ResponseSpeed; label: string; description: string }[] = [
  { value: 'slow', label: 'Slow', description: 'Weight accuracy over speed' },
  { value: 'normal', label: 'Normal', description: 'Balanced response cadence' },
  { value: 'fast', label: 'Fast', description: 'Reply as soon as possible' },
];

const toneOptions: { value: TonePreference; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: 'Balanced default tone' },
  { value: 'upbeat', label: 'Upbeat', description: 'Energetic and warm' },
  { value: 'professional', label: 'Professional', description: 'Formal and precise' },
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
  const [, startTransition] = useTransition();
  const canEditAgentType = isReceptionMateStaff();

  const query = useQuery({
    queryKey: ['agent-config', garageId],
    queryFn: () => fetchAgentConfiguration(garageId ?? undefined),
    enabled: Boolean(garageId),
  });

  const mutation = useMutation({
    mutationFn: (payload: AgentConfiguration) =>
      updateAgentConfiguration(payload, garageId ?? undefined),
    onSuccess: (data) => {
      setFormState(cloneConfiguration(data.configuration));
      setKnowledgeBase(data.knowledgeBase ?? []);
      setIsEditing(false);
      setFeedback('Configuration saved and applied to your agent.');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to save configuration. Please try again.';
      setFeedback(message);
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

  useEffect(() => {
    if (!query.data?.configuration) {
      return;
    }
    startTransition(() => {
      setFormState(cloneConfiguration(query.data.configuration));
      setKnowledgeBase(query.data.knowledgeBase ?? []);
      setDiscoveredPages([]);
      setSelectedPageUrls([]);
      setLastScanUrl(null);
    });
  }, [query.data, startTransition]);

  const hasGarage = useMemo(() => Boolean(garageId), [garageId]);

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

  const handleResponseSpeedChange = (value: ResponseSpeed) => {
    if (!isEditing || mutation.isPending) {
      return;
    }
    setFormState((prev) => ({ ...prev, responseSpeed: value }));
    setFeedback(null);
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
              <span className="text-xs uppercase tracking-wide text-slate-500">Call summary email</span>
              <input
                type="email"
                value={formState.callSummaryEmail}
                onChange={handleInputChange('callSummaryEmail')}
                disabled={!isEditing || mutation.isPending}
                placeholder="Where daily summaries should be delivered"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-slate-100">Tone & Booking Rules</h2>
          <p className="mt-1 text-sm text-slate-400">
            Control how the AI sounds and how it handles booking requests.
          </p>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
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

          <div className="mt-8">
            <span className="text-xs uppercase tracking-wide text-slate-500">Response speed</span>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              {responseSpeedOptions.map((option) => {
                const isSelected = formState.responseSpeed === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/15 text-slate-100'
                        : 'border-slate-800 bg-slate-900/50 text-slate-300 hover:border-slate-700 hover:text-slate-200'
                    } ${!isEditing || mutation.isPending ? 'cursor-not-allowed opacity-60' : ''}`}
                    onClick={() => handleResponseSpeedChange(option.value)}
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
            <span className="text-xs uppercase tracking-wide text-slate-500">Interruption sensitivity</span>
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
                  aria-valuetext={`${formState.interruptionSensitivity.toFixed(1)} sensitivity`}
                  className="h-2 w-full cursor-pointer rounded-full bg-slate-800 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <span className="text-xs text-slate-400">{formState.interruptionSensitivity.toFixed(1)} (0 = rarely interrupt, 1 = interrupt quickly)</span>
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
        </section>

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
    </div>
  );
}

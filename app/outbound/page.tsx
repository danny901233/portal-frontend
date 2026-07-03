'use client';

import { useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import {
  createOutboundCampaign,
  fetchOutboundCampaigns,
  fetchOutboundCampaign,
  fetchGarageTemplates,
  sendOutboundCampaign,
  fetchGarageHiveReminders,
  fetchGarageHiveSettings,
  updateGarageHiveSettings,
} from '../lib/api';
import type { OutboundCampaign, OutboundContact, OutboundContactInput, MessageTemplate } from '../lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-600',
  sending: 'bg-yellow-500/20 text-yellow-300',
  sent: 'bg-green-500/20 text-green-300',
  processed: 'bg-green-500/20 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sending: 'Sending',
  sent: 'Processed',
  processed: 'Processed',
  failed: 'Failed',
};

const REQUIRED_COLS = ['customer_name', 'phone'];

function parseCSV(text: string): { rows: OutboundContactInput[]; error?: string } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { rows: [], error: 'CSV must have a header row and at least one data row.' };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));

  for (const col of REQUIRED_COLS) {
    if (!header.includes(col)) {
      return { rows: [], error: `Missing required column: "${col}"` };
    }
  }

  const idx = (col: string) => header.indexOf(col);

  const rows: OutboundContactInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields
    const cells: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cells.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    cells.push(current.trim());

    const get = (col: string) => (idx(col) >= 0 ? cells[idx(col)]?.trim() || undefined : undefined);

    const customerName = get('customer_name');
    const rawPhone = get('phone');
    if (!customerName || !rawPhone) continue;

    // Fix scientific notation phone numbers exported by Excel (e.g. 4.47911E+11 → +447911...)
    let phone = rawPhone;
    let truncated = false;
    if (/^\d+\.?\d*[eE][+\-]?\d+$/.test(rawPhone)) {
      const expanded = Number(rawPhone).toFixed(0);
      phone = expanded.startsWith('44') ? `+${expanded}` : expanded;
      // Warn if precision was lost — trailing zeros suggest Excel rounded the number
      if (/0{4,}$/.test(expanded)) truncated = true;
    }
    if (truncated) {
      return { rows: [], error: `Phone number precision lost in row ${i} ("${rawPhone}" → "${phone}"). Excel has rounded this number. Please format the Phone column as Text in Excel before saving as CSV, or use a text editor to create the CSV.` };
    }

    rows.push({
      customerName,
      phone,
      registration: get('registration'),
      motDueDate: get('mot_due_date'),
      serviceDueDate: get('service_due_date'),
    });
  }

  if (rows.length === 0) return { rows: [], error: 'No valid rows found in CSV.' };
  return { rows };
}

export default function OutboundPage() {
  const router = useRouter();
  const garageId = getGarageId() || '';
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!garageId) return;
    const token = getSessionToken();
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/messaging-access`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((data: { hasMessagingAccess?: boolean }) => {
        if (!data.hasMessagingAccess) router.replace('/dashboard');
      })
      .catch(() => router.replace('/dashboard'));
  }, [garageId, router]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [campaignName, setCampaignName] = useState('');
  const [channel, setChannel] = useState<'sms' | 'whatsapp'>('whatsapp');
  const [source, setSource] = useState<'csv' | 'garagehive'>('csv');
  const [ghDays, setGhDays] = useState(30);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghSkipped, setGhSkipped] = useState<{ reg: string; reason: string }[]>([]);
  // Automatic daily reminder settings (mirrors GarageHiveConnection)
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoDays, setAutoDays] = useState(30);
  const [autoTemplateId, setAutoTemplateId] = useState('');
  const [preview, setPreview] = useState<OutboundContactInput[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null); // used for new campaign send only
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [variableMapping, setVariableMapping] = useState<Record<string, string>>({});
  const [selectedCampaign, setSelectedCampaign] = useState<OutboundCampaign | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const { data, isLoading } = useQuery({
    queryKey: ['outbound-campaigns', garageId],
    queryFn: () => fetchOutboundCampaigns(garageId),
    enabled: !!garageId,
  });

  const { data: templatesData } = useQuery({
    queryKey: ['templates', garageId],
    queryFn: () => fetchGarageTemplates(garageId),
    enabled: !!garageId && (channel === 'whatsapp' || source === 'garagehive'),
  });

  // Automatic daily reminder settings (Garage Hive connection)
  const { data: ghSettings } = useQuery({
    queryKey: ['gh-settings', garageId],
    queryFn: () => fetchGarageHiveSettings(garageId),
    enabled: !!garageId && source === 'garagehive',
  });

  useEffect(() => {
    if (!ghSettings?.connected) return;
    setAutoEnabled(!!ghSettings.remindersEnabled);
    setAutoDays(ghSettings.reminderDaysAhead ?? 30);
    setAutoTemplateId(ghSettings.reminderTemplateId ?? '');
  }, [ghSettings]);

  const saveSettingsMutation = useMutation({
    mutationFn: updateGarageHiveSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gh-settings', garageId] });
      showToast('success', 'Garage Hive reminder settings saved.');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      showToast('error', msg || 'Failed to save reminder settings.');
    },
  });

  const approvedTemplates: MessageTemplate[] = (templatesData?.templates || []).filter(
    (t) => t.status === 'approved',
  );

  const selectedTemplate = approvedTemplates.find((t) => t.id === selectedTemplateId) || null;

  // Extract variable numbers from template body e.g. {{1}}, {{2}}
  const templateVariables = selectedTemplate
    ? [...new Set([...selectedTemplate.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))]
        .sort((a, b) => Number(a) - Number(b))
    : [];

  // Auto-fill variable mapping from template's saved field assignments
  useEffect(() => {
    if (!selectedTemplate?.variableSamples) {
      setVariableMapping({});
      return;
    }
    const samples = selectedTemplate.variableSamples as Record<string, string>;
    const autoMap: Record<string, string> = {};
    for (const varNum of templateVariables) {
      const fieldKey = `{{${varNum}}}_field`;
      if (samples[fieldKey]) autoMap[varNum] = samples[fieldKey];
    }
    if (Object.keys(autoMap).length > 0) setVariableMapping(autoMap);
  }, [selectedTemplateId]);

  const createMutation = useMutation({
    mutationFn: createOutboundCampaign,
    onSuccess: async ({ campaign }) => {
      queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
      const dncCount = campaign.contacts?.filter((c) => c.status === 'opted_out').length ?? 0;
      const sendable = campaign.totalContacts - dncCount;
      if (dncCount > 0) {
        showToast('error', `${dncCount} contact${dncCount > 1 ? 's' : ''} skipped — previously opted out. ${sendable} will be messaged.`);
      }
      setSendingId(campaign.id);
      try {
        await sendOutboundCampaign(campaign.id);
        showToast('success', `Messages are being sent to ${sendable} contact${sendable !== 1 ? 's' : ''}!`);
      } catch {
        showToast('error', 'Campaign created but failed to trigger send. Try the Send button on the campaign.');
      } finally {
        setSendingId(null);
        queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
        resetForm();
      }
    },
    onError: () => showToast('error', 'Failed to create campaign.'),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setPreview(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { rows, error } = parseCSV(text);
      if (error) {
        setParseError(error);
      } else {
        setPreview(rows);
      }
    };
    reader.readAsText(file);
  };

  const handlePullFromGarageHive = async () => {
    setParseError(null);
    setPreview(null);
    setGhSkipped([]);
    setGhLoading(true);
    try {
      const { contacts, skipped } = await fetchGarageHiveReminders(garageId, ghDays);
      setGhSkipped(skipped);
      if (contacts.length === 0) {
        setParseError(`No vehicles due in ${ghDays} days found in Garage Hive.`);
      } else {
        setPreview(contacts);
      }
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
      setParseError(
        data?.code === 'GARAGEHIVE_NOT_CONNECTED'
          ? 'Garage Hive is not connected for this garage yet.'
          : data?.error || 'Failed to fetch reminders from Garage Hive.',
      );
    } finally {
      setGhLoading(false);
    }
  };

  const resetForm = () => {
    setCampaignName('');
    setChannel('whatsapp');
    setSource('csv');
    setGhDays(30);
    setGhSkipped([]);
    setPreview(null);
    setParseError(null);
    setSelectedTemplateId('');
    setVariableMapping({});
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleImportAndSend = () => {
    if (!preview || preview.length === 0) return;
    if (!campaignName.trim()) {
      showToast('error', 'Please enter a campaign name.');
      return;
    }
    if (channel === 'whatsapp' && !selectedTemplateId) {
      showToast('error', 'Please select an approved WhatsApp template. Plain text messages cannot be delivered outside the 24-hour window.');
      return;
    }
    createMutation.mutate({
      garageId,
      name: campaignName.trim(),
      channel,
      contacts: preview,
      ...(selectedTemplateId && { messageTemplateId: selectedTemplateId, variableMapping }),
    });
  };

  const handleViewResults = async (campaign: OutboundCampaign) => {
    setLoadingContacts(true);
    try {
      const { campaign: full } = await fetchOutboundCampaign(campaign.id);
      setSelectedCampaign(full);
    } catch {
      showToast('error', 'Failed to load campaign results.');
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleResend = async (campaign: OutboundCampaign) => {
    setSendingId(campaign.id);
    try {
      await sendOutboundCampaign(campaign.id);
      showToast('success', 'Messages sent!');
      queryClient.invalidateQueries({ queryKey: ['outbound-campaigns', garageId] });
    } catch {
      showToast('error', 'Failed to send messages.');
    } finally {
      setSendingId(null);
    }
  };

  const campaigns: OutboundCampaign[] = data?.campaigns || [];

  return (
    <div className="space-y-8">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-6 right-6 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-lg',
            toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white',
          )}
        >
          {toast.msg}
        </div>
      )}

      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Outbound Messaging</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a customer list and send personalised MOT or service reminders via SMS or WhatsApp.
          Customers who reply will be handled automatically by your AI agent.
        </p>
      </div>

      {/* New Campaign */}
      <div className="rounded-xl border border-slate-300 bg-white p-6">
        <h2 className="mb-4 text-base font-semibold text-slate-900">New Campaign</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Campaign name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Campaign name</label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g. March MOT Reminders"
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Channel */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Channel</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'sms' | 'whatsapp')}
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
        </div>

        {/* Template selector (WhatsApp only) */}
        {channel === 'whatsapp' && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              Message template{' '}
              <span className="text-slate-500">(optional — uses default reminder if not selected)</span>
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                setVariableMapping({});
              }}
              className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              <option value="">— Use default reminder message —</option>
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {approvedTemplates.length === 0 && (
              <p className="mt-1 text-xs text-slate-500">
                No approved templates yet.{' '}
                <a href="/templates" className="text-blue-400 hover:underline">Create and approve one</a>{' '}
                to use custom messages.
              </p>
            )}

            {/* Variable mapping */}
            {selectedTemplate && templateVariables.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-medium text-slate-600">Map template variables to CSV columns:</p>
                <p className="mb-3 text-xs text-slate-500 font-mono bg-slate-100 rounded px-2 py-1">
                  {selectedTemplate.bodyText}
                </p>
                <div className="space-y-2">
                  {templateVariables.map((varNum) => (
                    <div key={varNum} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-xs font-mono text-blue-400">{`{{${varNum}}}`}</span>
                      <select
                        value={variableMapping[varNum] || ''}
                        onChange={(e) => setVariableMapping((prev) => ({ ...prev, [varNum]: e.target.value }))}
                        className="flex-1 rounded border border-slate-300 bg-slate-100 px-2 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">— select column —</option>
                        <option value="customer_name">customer_name (first name)</option>
                        <option value="full_name">full_name</option>
                        <option value="phone">phone</option>
                        <option value="registration">registration</option>
                        <option value="mot_due_date">mot_due_date</option>
                        <option value="service_due_date">service_due_date</option>
                        <option value="garage_name">garage_name</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Source toggle: CSV upload or pull live from Garage Hive */}
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-slate-500">Contact source</label>
          <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
            {(['csv', 'garagehive'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSource(s);
                  setPreview(null);
                  setParseError(null);
                  setGhSkipped([]);
                }}
                className={cn(
                  'rounded-md px-4 py-1.5 text-xs font-medium transition-colors',
                  source === s ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {s === 'csv' ? 'CSV upload' : 'Garage Hive'}
              </button>
            ))}
          </div>
        </div>

        {/* Automatic daily reminders */}
        {source === 'garagehive' && (
          ghSettings && !ghSettings.connected ? (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">Garage Hive isn&rsquo;t connected for this garage yet.</p>
              <p className="mt-1 text-xs text-amber-700">
                Once the Garage Hive connection is set up, you can turn on automatic daily reminders here.
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Automatic daily reminders</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Every morning at 9am we pull vehicles due in Garage Hive and message the customer
                    automatically. Delivery, read and reply status is tracked for each one.
                  </p>
                </div>
                {/* Toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoEnabled}
                  onClick={() => setAutoEnabled((v) => !v)}
                  className={cn(
                    'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    autoEnabled ? 'bg-green-500' : 'bg-slate-300',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                      autoEnabled ? 'translate-x-5' : 'translate-x-0.5',
                    )}
                  />
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">Remind when due within (days)</label>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={autoDays}
                    onChange={(e) => setAutoDays(Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                  />
                </div>
                <div className="min-w-[220px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-slate-500">WhatsApp template</label>
                  <select
                    value={autoTemplateId}
                    onChange={(e) => setAutoTemplateId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                  >
                    <option value="">Select an approved template…</option>
                    {approvedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    saveSettingsMutation.mutate({
                      garageId,
                      remindersEnabled: autoEnabled,
                      reminderDaysAhead: autoDays,
                      reminderTemplateId: autoTemplateId || null,
                    })
                  }
                  disabled={saveSettingsMutation.isPending}
                  className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {saveSettingsMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>

              {approvedTemplates.length === 0 && (
                <p className="mt-3 text-xs text-amber-600">
                  No approved WhatsApp templates yet — you&rsquo;ll need one before reminders can be sent automatically.
                </p>
              )}
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className={cn('inline-block h-2 w-2 rounded-full', autoEnabled ? 'bg-green-500' : 'bg-slate-400')} />
                <span className="text-slate-500">
                  {ghSettings?.remindersEnabled ? 'Automatic reminders are ON — runs daily at 9am.' : 'Automatic reminders are off.'}
                  {ghSettings?.lastRunAt && ` Last run: ${new Date(ghSettings.lastRunAt).toLocaleString('en-GB')}.`}
                  {ghSettings?.lastRunError && ` Last error: ${ghSettings.lastRunError}`}
                </span>
              </div>
            </div>
          )
        )}

        {/* Manual one-off pull (ad-hoc / preview) */}
        {source === 'garagehive' && (
          <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-4">
            <p className="mb-3 text-xs text-slate-500">
              <span className="font-medium text-slate-600">Or send a one-off now.</span> Pull customers whose MOT or
              service falls due in Garage Hive. Vehicles marked &ldquo;disable reminders&rdquo; are automatically excluded.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Due within (days)</label>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={ghDays}
                  onChange={(e) => setGhDays(Number(e.target.value))}
                  className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                />
              </div>
              <button
                type="button"
                onClick={handlePullFromGarageHive}
                disabled={ghLoading}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {ghLoading ? 'Fetching…' : 'Pull from Garage Hive'}
              </button>
            </div>
            {ghSkipped.length > 0 && (
              <p className="mt-3 text-xs text-amber-600">
                {ghSkipped.length} vehicle{ghSkipped.length > 1 ? 's' : ''} skipped (no contact number or
                unlinked customer).
              </p>
            )}
          </div>
        )}

        {/* CSV Upload */}
        <div className={cn('mt-4', source !== 'csv' && 'hidden')}>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-500">
              Customer CSV{' '}
              <span className="text-slate-500">
                (columns: customer_name, phone, registration, mot_due_date, service_due_date)
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                const sample = [
                  'customer_name,phone,registration,mot_due_date,service_due_date',
                  'John Smith,+447911123456,AB12CDE,15-Apr-26,',
                  'Sarah Jones,+447922654321,XY21FGH,,20-May-26',
                ].join('\r\n');
                const blob = new Blob([sample], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'outbound_template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
            >
              Download sample CSV
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="block w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-xs file:text-slate-700 hover:border-slate-500"
          />
          {parseError && (
            <p className="mt-2 text-xs text-red-400">{parseError}</p>
          )}
        </div>

        {/* Preview table */}
        {preview && preview.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs text-slate-500">
              {preview.length} contact{preview.length !== 1 ? 's' : ''}{' '}
              {source === 'garagehive' ? 'from Garage Hive' : 'imported'} — preview:
            </p>
            <div className="overflow-x-auto rounded-lg border border-slate-300">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Reg</th>
                    <th className="px-3 py-2">MOT Due</th>
                    <th className="px-3 py-2">Service Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.slice(0, 10).map((c, i) => (
                    <tr key={i} className="text-slate-600">
                      <td className="px-3 py-2">{c.customerName}</td>
                      <td className="px-3 py-2">{c.phone}</td>
                      <td className="px-3 py-2">{c.registration || '—'}</td>
                      <td className="px-3 py-2">{c.motDueDate || '—'}</td>
                      <td className="px-3 py-2">{c.serviceDueDate || '—'}</td>
                    </tr>
                  ))}
                  {preview.length > 10 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-center text-slate-500">
                        …and {preview.length - 10} more
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={handleImportAndSend}
                disabled={createMutation.isPending || sendingId !== null}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createMutation.isPending || sendingId !== null ? 'Sending…' : `Send ${preview.length} Reminders`}
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Past campaigns */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Past Campaigns</h2>

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading campaigns…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-slate-500">No campaigns yet. Upload a CSV above to get started.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-300">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Contacts</th>
                  <th className="px-4 py-3">Sent Rate</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => handleViewResults(c)}
                    className="cursor-pointer text-slate-600 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-3 capitalize">{c.channel}</td>
                    <td className="px-4 py-3">{c.totalContacts}</td>
                    <td className="px-4 py-3">
                      {c.status === 'draft' || c.status === 'sending' ? (
                        <span className="text-slate-500 text-xs">—</span>
                      ) : (
                        (() => {
                          const rate = c.totalContacts > 0 ? Math.round((c.sentCount / c.totalContacts) * 100) : 0;
                          const color = rate === 100 ? 'text-green-400' : rate >= 50 ? 'text-yellow-400' : 'text-red-400';
                          return (
                            <span className={`text-sm font-medium ${color}`}>
                              {rate}%
                              <span className="ml-1 text-xs text-slate-500">({c.sentCount}/{c.totalContacts})</span>
                            </span>
                          );
                        })()
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_COLORS[c.status] || 'bg-slate-500/20 text-slate-600',
                        )}
                      >
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(c.createdAt).toLocaleDateString('en-GB')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Campaign Results Modal */}
      {(selectedCampaign || loadingContacts) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSelectedCampaign(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-slate-300 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-slate-300 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {selectedCampaign?.name ?? 'Loading…'}
                </h2>
                {selectedCampaign && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {selectedCampaign.sentCount} sent · {selectedCampaign.totalContacts} total ·{' '}
                    {new Date(selectedCampaign.createdAt).toLocaleDateString('en-GB')}
                  </p>
                )}
              </div>
              <button
                onClick={() => setSelectedCampaign(null)}
                className="rounded p-1 text-slate-500 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            {/* Delivery / open / reply report */}
            {selectedCampaign?.contacts?.length ? (
              (() => {
                const contacts = selectedCampaign.contacts!;
                const count = (fn: (s: string) => boolean) => contacts.filter((c) => fn(c.status)).length;
                // Statuses are progressive (read implies delivered) — count cumulatively.
                const sent = count((s) => ['sent', 'delivered', 'read', 'replied'].includes(s));
                const delivered = count((s) => ['delivered', 'read', 'replied'].includes(s));
                const read = count((s) => ['read', 'replied'].includes(s));
                const replied = count((s) => s === 'replied');
                const failed = count((s) => s === 'failed');
                const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0);
                const stat = (label: string, n: number, showPct = true) => (
                  <div className="flex-1 text-center">
                    <p className="text-lg font-semibold text-slate-900">{n}</p>
                    <p className="text-[11px] text-slate-500">
                      {label}
                      {showPct && sent ? ` · ${pct(n)}%` : ''}
                    </p>
                  </div>
                );
                return (
                  <div className="flex items-stretch gap-1 border-b border-slate-200 bg-slate-50 px-6 py-3">
                    {stat('Sent', sent, false)}
                    {stat('Delivered', delivered)}
                    {stat('Read', read)}
                    {stat('Replied', replied)}
                    {failed > 0 && stat('Failed', failed)}
                  </div>
                );
              })()
            ) : null}

            {/* Modal body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {loadingContacts ? (
                <p className="px-6 py-8 text-center text-sm text-slate-500">Loading contacts…</p>
              ) : !selectedCampaign?.contacts?.length ? (
                <p className="px-6 py-8 text-center text-sm text-slate-500">No contacts found.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Name</th>
                      <th className="px-4 py-2">Phone</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {selectedCampaign.contacts!.map((contact) => {
                      const statusColor: Record<string, string> = {
                        pending: 'text-yellow-400',
                        sent: 'text-blue-400',
                        delivered: 'text-green-400',
                        read: 'text-green-300',
                        replied: 'text-purple-400',
                        failed: 'text-red-400',
                        opted_out: 'text-slate-500',
                      };
                      const statusLabel: Record<string, string> = {
                        pending: 'Pending',
                        sent: 'Sent (unconfirmed)',
                        delivered: 'Delivered',
                        read: 'Read',
                        replied: 'Replied',
                        failed: 'Failed',
                        opted_out: 'Opted Out',
                      };
                      return (
                        <tr key={contact.id} className="text-slate-600">
                          <td className="px-4 py-2">{contact.customerName}</td>
                          <td className="px-4 py-2 font-mono text-xs">{contact.phone}</td>
                          <td className={`px-4 py-2 text-xs font-medium ${statusColor[contact.status] ?? 'text-slate-500'}`}>
                            {statusLabel[contact.status] ?? contact.status}
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500">
                            {contact.errorReason || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

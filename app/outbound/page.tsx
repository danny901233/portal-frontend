'use client';

import { useRef, useState } from 'react';
import { getGarageId } from '../lib/auth';
import { cn } from '../lib/utils';
import {
  createOutboundCampaign,
  fetchOutboundCampaigns,
  sendOutboundCampaign,
} from '../lib/api';
import type { OutboundCampaign, OutboundContactInput } from '../lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-300',
  sending: 'bg-yellow-500/20 text-yellow-300',
  sent: 'bg-green-500/20 text-green-300',
};

const REQUIRED_COLS = ['customer_name', 'phone'];
const EXPECTED_COLS = ['customer_name', 'phone', 'registration', 'mot_due_date', 'service_due_date'];

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
    const phone = get('phone');
    if (!customerName || !phone) continue;

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
  const garageId = getGarageId() || '';
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [campaignName, setCampaignName] = useState('');
  const [channel, setChannel] = useState<'sms' | 'whatsapp'>('sms');
  const [preview, setPreview] = useState<OutboundContactInput[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const { data, isLoading } = useQuery({
    queryKey: ['outbound-campaigns', garageId],
    queryFn: () => fetchOutboundCampaigns(garageId),
    enabled: !!garageId,
  });

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

  const resetForm = () => {
    setCampaignName('');
    setChannel('sms');
    setPreview(null);
    setParseError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleImportAndSend = () => {
    if (!preview || preview.length === 0) return;
    if (!campaignName.trim()) {
      showToast('error', 'Please enter a campaign name.');
      return;
    }
    createMutation.mutate({ garageId, name: campaignName.trim(), channel, contacts: preview });
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
        <h1 className="text-2xl font-semibold text-slate-100">Outbound Messaging</h1>
        <p className="mt-1 text-sm text-slate-400">
          Upload a customer list and send personalised MOT or service reminders via SMS or WhatsApp.
          Customers who reply will be handled automatically by your AI agent.
        </p>
      </div>

      {/* New Campaign */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h2 className="mb-4 text-base font-semibold text-slate-100">New Campaign</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Campaign name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Campaign name</label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g. March MOT Reminders"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Channel */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Channel</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'sms' | 'whatsapp')}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
        </div>

        {/* CSV Upload */}
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-slate-400">
            Customer CSV{' '}
            <span className="text-slate-500">
              (columns: customer_name, phone, registration, mot_due_date, service_due_date)
            </span>
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="block w-full cursor-pointer rounded-lg border border-dashed border-slate-600 bg-slate-800/50 px-4 py-3 text-sm text-slate-400 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-xs file:text-slate-200 hover:border-slate-500"
          />
          {parseError && (
            <p className="mt-2 text-xs text-red-400">{parseError}</p>
          )}
        </div>

        {/* Preview table */}
        {preview && preview.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs text-slate-400">{preview.length} contacts imported — preview:</p>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-800 text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Reg</th>
                    <th className="px-3 py-2">MOT Due</th>
                    <th className="px-3 py-2">Service Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {preview.slice(0, 10).map((c, i) => (
                    <tr key={i} className="text-slate-300">
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
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Past campaigns */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-slate-100">Past Campaigns</h2>

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading campaigns…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-slate-500">No campaigns yet. Upload a CSV above to get started.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-700">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Contacts</th>
                  <th className="px-4 py-3">Sent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {campaigns.map((c) => (
                  <tr key={c.id} className="text-slate-300 hover:bg-slate-800/40">
                    <td className="px-4 py-3 font-medium text-slate-100">{c.name}</td>
                    <td className="px-4 py-3 capitalize">{c.channel}</td>
                    <td className="px-4 py-3">{c.totalContacts}</td>
                    <td className="px-4 py-3">{c.sentCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_COLORS[c.status] || 'bg-slate-500/20 text-slate-300',
                        )}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(c.createdAt).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-4 py-3">
                      {c.status !== 'sent' && (
                        <button
                          onClick={() => handleResend(c)}
                          disabled={sendingId === c.id}
                          className="rounded bg-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-50"
                        >
                          {sendingId === c.id ? 'Sending…' : 'Send'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

interface MessageTemplate {
  id: string;
  name: string;
  category: string;
  language: string;
  headerType: string | null;
  headerContent: string | null;
  bodyText: string;
  footerText: string | null;
  buttonType: string | null;
  buttonText: string | null;
  buttonValue: string | null;
  metaTemplateId: string | null;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-300',
  pending: 'bg-yellow-500/20 text-yellow-300',
  approved: 'bg-green-500/20 text-green-300',
  rejected: 'bg-red-500/20 text-red-300',
};

const CATEGORIES = [
  { value: 'UTILITY', label: 'Utility', desc: 'Appointment reminders, order updates' },
  { value: 'MARKETING', label: 'Marketing', desc: 'Promotions, offers, re-engagement' },
];

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('UTILITY');
  const [formBody, setFormBody] = useState('');
  const [formHeader, setFormHeader] = useState('');
  const [formFooter, setFormFooter] = useState('');
  const [formButtonType, setFormButtonType] = useState('none');
  const [formButtonText, setFormButtonText] = useState('');
  const [formButtonValue, setFormButtonValue] = useState('');

  const garageId = typeof window !== 'undefined' ? getGarageId() : null;
  const token = typeof window !== 'undefined' ? getSessionToken() : null;
  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  useEffect(() => {
    if (!garageId || !token) {
      router.push('/login');
      return;
    }
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.templates) setTemplates(data.templates);
    } catch (e) {
      console.error('Failed to load templates:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: formName,
          category: formCategory,
          bodyText: formBody,
          headerType: formHeader ? 'text' : null,
          headerContent: formHeader || null,
          footerText: formFooter || null,
          buttonType: formButtonType !== 'none' ? formButtonType : null,
          buttonText: formButtonType !== 'none' ? formButtonText : null,
          buttonValue: formButtonType !== 'none' ? formButtonValue : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create template');
        return;
      }
      setSuccess('Template created! You can now submit it to WhatsApp for approval.');
      setShowForm(false);
      resetForm();
      fetchTemplates();
    } catch (e) {
      setError('Failed to create template');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitToMeta(templateId: string) {
    setError(null);
    setSyncing(templateId);

    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}/submit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to submit to WhatsApp');
        return;
      }
      setSuccess('Template submitted to WhatsApp for approval!');
      fetchTemplates();
    } catch (e) {
      setError('Failed to submit template');
    } finally {
      setSyncing(null);
    }
  }

  async function handleSync(templateId: string) {
    setSyncing(templateId);
    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to sync status');
        return;
      }
      fetchTemplates();
    } catch (e) {
      setError('Failed to sync');
    } finally {
      setSyncing(null);
    }
  }

  async function handleDelete(templateId: string) {
    if (!confirm('Are you sure you want to delete this template?')) return;

    try {
      const res = await fetch(`${API}/api/garages/${garageId}/templates/${templateId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError('Failed to delete template');
        return;
      }
      setSuccess('Template deleted.');
      fetchTemplates();
    } catch (e) {
      setError('Failed to delete template');
    }
  }

  function resetForm() {
    setFormName('');
    setFormCategory('UTILITY');
    setFormBody('');
    setFormHeader('');
    setFormFooter('');
    setFormButtonType('none');
    setFormButtonText('');
    setFormButtonValue('');
  }

  // Count variables in body text
  const variableCount = (formBody.match(/\{\{\d+\}\}/g) || []).length;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-blue-500" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Message Templates</h1>
          <p className="mt-1 text-sm text-slate-400">
            Create WhatsApp message templates for appointment reminders, marketing, and more.
            Templates must be approved by Meta before use.
          </p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); setError(null); setSuccess(null); }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          {showForm ? 'Cancel' : '+ New Template'}
        </button>
      </div>

      {/* Status messages */}
      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg bg-green-500/10 border border-green-500/20 px-4 py-3 text-sm text-green-300">
          {success}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="mb-8 rounded-xl border border-slate-700 bg-slate-800/50 p-6">
          <h2 className="mb-4 text-lg font-medium text-slate-100">Create Template</h2>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Template Name</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="e.g. mot_reminder"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                required
              />
              <p className="mt-1 text-xs text-slate-500">Lowercase, underscores only. No spaces.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Category</label>
              <select
                value={formCategory}
                onChange={e => setFormCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label} — {c.desc}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-300 mb-1">Header (optional)</label>
            <input
              type="text"
              value={formHeader}
              onChange={e => setFormHeader(e.target.value)}
              placeholder="e.g. MOT Reminder"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Body Text <span className="text-red-400">*</span>
            </label>
            <textarea
              value={formBody}
              onChange={e => setFormBody(e.target.value)}
              placeholder={'Hi {{1}}, your MOT is due on {{2}}. Book online at {{3}} or call us on {{4}}.'}
              rows={4}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              required
            />
            <p className="mt-1 text-xs text-slate-500">
              Use {'{{1}}'}, {'{{2}}'}, etc. for variables (customer name, date, etc.).
              {variableCount > 0 && (
                <span className="ml-2 text-blue-400">{variableCount} variable{variableCount > 1 ? 's' : ''} detected</span>
              )}
            </p>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-300 mb-1">Footer (optional)</label>
            <input
              type="text"
              value={formFooter}
              onChange={e => setFormFooter(e.target.value)}
              placeholder="e.g. Reply STOP to opt out"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-300 mb-1">Button (optional)</label>
            <div className="grid grid-cols-3 gap-3">
              <select
                value={formButtonType}
                onChange={e => setFormButtonType(e.target.value)}
                className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="none">No button</option>
                <option value="url">URL button</option>
                <option value="call">Call button</option>
              </select>
              {formButtonType !== 'none' && (
                <>
                  <input
                    type="text"
                    value={formButtonText}
                    onChange={e => setFormButtonText(e.target.value)}
                    placeholder="Button label"
                    className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={formButtonValue}
                    onChange={e => setFormButtonValue(e.target.value)}
                    placeholder={formButtonType === 'url' ? 'https://...' : '+44...'}
                    className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </>
              )}
            </div>
          </div>

          {/* Preview */}
          <div className="mb-6 rounded-lg border border-slate-600 bg-slate-900/50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Preview</h3>
            <div className="rounded-lg bg-[#075e54]/20 p-4 max-w-sm">
              {formHeader && <p className="font-semibold text-slate-200 mb-1">{formHeader}</p>}
              <p className="text-sm text-slate-300 whitespace-pre-wrap">
                {formBody || 'Your message will appear here...'}
              </p>
              {formFooter && <p className="mt-2 text-xs text-slate-500">{formFooter}</p>}
              {formButtonType !== 'none' && formButtonText && (
                <div className="mt-3 border-t border-slate-600 pt-2 text-center">
                  <span className="text-sm text-blue-400">{formButtonText}</span>
                </div>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Template'}
          </button>
        </form>
      )}

      {/* Template list */}
      {templates.length === 0 && !showForm ? (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-12 text-center">
          <p className="text-slate-400">No templates yet. Create your first template to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map(t => (
            <div key={t.id} className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="font-medium text-slate-100">{t.name}</h3>
                    <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_COLORS[t.status] || STATUS_COLORS.draft)}>
                      {t.status}
                    </span>
                    <span className="rounded-full bg-slate-700/50 px-2.5 py-0.5 text-xs text-slate-400">
                      {t.category}
                    </span>
                  </div>
                  {t.rejectionReason && (
                    <p className="mt-1 text-xs text-red-400">Rejection: {t.rejectionReason}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {t.status === 'draft' && (
                    <button
                      onClick={() => handleSubmitToMeta(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? 'Submitting...' : 'Submit to WhatsApp'}
                    </button>
                  )}
                  {t.status === 'pending' && (
                    <button
                      onClick={() => handleSync(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? 'Checking...' : 'Check Status'}
                    </button>
                  )}
                  {t.status === 'rejected' && (
                    <button
                      onClick={() => handleSubmitToMeta(t.id)}
                      disabled={syncing === t.id}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      {syncing === t.id ? 'Resubmitting...' : 'Resubmit'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(t.id)}
                    className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-600/40 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Template body preview */}
              <div className="rounded-lg bg-slate-900/50 p-3">
                {t.headerContent && <p className="font-semibold text-slate-300 text-sm mb-1">{t.headerContent}</p>}
                <p className="text-sm text-slate-400 whitespace-pre-wrap">{t.bodyText}</p>
                {t.footerText && <p className="mt-1 text-xs text-slate-500">{t.footerText}</p>}
                {t.buttonType && t.buttonText && (
                  <div className="mt-2 border-t border-slate-700 pt-2 text-center">
                    <span className="text-xs text-blue-400">{t.buttonText}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

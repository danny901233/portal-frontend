'use client';

import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ChangeEvent } from 'react';

type TabKey = 'sidebar' | 'agent-index' | 'faqs' | 'rules' | 'capture' | 'goals' | 'pronunciations';

type Faq = {
  id: string;
  question: string;
  answer: string;
};

type RulePriority = 'high' | 'normal' | 'low';

type AgentRule = {
  id: string;
  text: string;
  priority: RulePriority;
  enabled: boolean;
};

type CaptureFieldType = 'text' | 'email' | 'phone' | 'date' | 'number' | 'vrn';

type CaptureField = {
  id: string;
  key: string;
  label: string;
  type: CaptureFieldType;
  required: boolean;
  enabled: boolean;
  isCustom: boolean;
  helpText?: string;
};

type CapturePreset = {
  id: string;
  name: string;
  description: string;
  fields: Array<Omit<CaptureField, 'id'>>;
};

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const seedFaqs: Faq[] = [
  {
    id: newId(),
    question: 'Do you do MOTs on Saturdays?',
    answer:
      'Yes — we run Saturday MOTs from 8:30am until 1pm. Slots fill quickly, so we recommend booking at least a week ahead.',
  },
  {
    id: newId(),
    question: 'How much is a brake pad replacement?',
    answer:
      'Front pads typically range from £95 to £180 depending on make and model. Final price is confirmed after inspection.',
  },
  {
    id: newId(),
    question: 'Do you offer courtesy cars?',
    answer:
      'We have two courtesy cars available on a first-come basis. Please request one when you book — we will confirm by SMS the day before.',
  },
];

const seedRules: AgentRule[] = [
  {
    id: newId(),
    text: 'Never recommend other garages, even if we cannot fit the customer in.',
    priority: 'high',
    enabled: true,
  },
  {
    id: newId(),
    text: 'Always confirm the vehicle registration back to the caller letter-by-letter before booking.',
    priority: 'high',
    enabled: true,
  },
  {
    id: newId(),
    text: 'If the caller mentions work over £500, offer to transfer to the manager.',
    priority: 'normal',
    enabled: true,
  },
  {
    id: newId(),
    text: 'Do not quote prices for diagnostic work without an inspection.',
    priority: 'normal',
    enabled: true,
  },
];

const defaultCaptureFields: CaptureField[] = [
  { id: newId(), key: 'name', label: 'Full name', type: 'text', required: true, enabled: true, isCustom: false },
  { id: newId(), key: 'phone', label: 'Contact number', type: 'phone', required: true, enabled: true, isCustom: false },
  { id: newId(), key: 'vrn', label: 'Vehicle registration', type: 'vrn', required: true, enabled: true, isCustom: false },
  { id: newId(), key: 'service', label: 'Service required', type: 'text', required: true, enabled: true, isCustom: false },
  { id: newId(), key: 'preferred_date', label: 'Preferred date', type: 'date', required: false, enabled: true, isCustom: false },
  { id: newId(), key: 'email', label: 'Email address', type: 'email', required: false, enabled: false, isCustom: false },
  { id: newId(), key: 'address', label: 'Address / postcode', type: 'text', required: false, enabled: false, isCustom: false },
  { id: newId(), key: 'mileage', label: 'Current mileage', type: 'number', required: false, enabled: false, isCustom: false },
];

const presets: CapturePreset[] = [
  {
    id: 'preset-mot-only',
    name: 'MOT-only garage',
    description: 'Lean capture for high-volume MOT centres — just enough to book the slot.',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true, enabled: true, isCustom: false },
      { key: 'phone', label: 'Contact number', type: 'phone', required: true, enabled: true, isCustom: false },
      { key: 'vrn', label: 'Vehicle registration', type: 'vrn', required: true, enabled: true, isCustom: false },
      { key: 'preferred_date', label: 'Preferred date', type: 'date', required: true, enabled: true, isCustom: false },
    ],
  },
  {
    id: 'preset-full-service',
    name: 'Full-service garage',
    description: 'Standard ReceptionMate capture set — service type, contact, email for confirmation.',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true, enabled: true, isCustom: false },
      { key: 'phone', label: 'Contact number', type: 'phone', required: true, enabled: true, isCustom: false },
      { key: 'email', label: 'Email address', type: 'email', required: true, enabled: true, isCustom: false },
      { key: 'vrn', label: 'Vehicle registration', type: 'vrn', required: true, enabled: true, isCustom: false },
      { key: 'service', label: 'Service required', type: 'text', required: true, enabled: true, isCustom: false },
      { key: 'preferred_date', label: 'Preferred date', type: 'date', required: false, enabled: true, isCustom: false },
      { key: 'mileage', label: 'Current mileage', type: 'number', required: false, enabled: true, isCustom: false },
    ],
  },
  {
    id: 'preset-tyre-centre',
    name: 'Tyre centre',
    description: 'For Tyresoft-style garages where tyre size and quantity matter most.',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true, enabled: true, isCustom: false },
      { key: 'phone', label: 'Contact number', type: 'phone', required: true, enabled: true, isCustom: false },
      { key: 'vrn', label: 'Vehicle registration', type: 'vrn', required: true, enabled: true, isCustom: false },
      { key: 'tyre_size', label: 'Tyre size', type: 'text', required: true, enabled: true, isCustom: true, helpText: 'e.g. 205/55 R16' },
      { key: 'tyre_count', label: 'Number of tyres', type: 'number', required: true, enabled: true, isCustom: true },
    ],
  },
];

const priorityStyles: Record<RulePriority, string> = {
  high: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  normal: 'border-slate-700 bg-slate-800/60 text-slate-200',
  low: 'border-slate-700 bg-slate-900 text-slate-400',
};

const priorityLabels: Record<RulePriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const fieldTypeLabels: Record<CaptureFieldType, string> = {
  text: 'Text',
  email: 'Email',
  phone: 'Phone',
  date: 'Date',
  number: 'Number',
  vrn: 'Vehicle reg',
};

const validTabs: TabKey[] = ['sidebar', 'agent-index', 'faqs', 'rules', 'capture', 'goals', 'pronunciations'];

export default function JodieSamplePage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabKey>('sidebar');

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam && (validTabs as string[]).includes(tabParam)) {
      setActiveTab(tabParam as TabKey);
    }
  }, [searchParams]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
          Local preview - inspired by Jodie, not a 1:1 copy
        </div>
        <h1 className="text-2xl font-semibold text-slate-50">ReceptionMatized Preview</h1>
        <p className="max-w-2xl text-sm text-slate-400">
          A working preview of how ReceptionMate&rsquo;s portal could feel after taking inspiration from
          heyjodie.com&rsquo;s &ldquo;simple but effective&rdquo; pattern. The first two tabs are structural
          (sidebar + settings index). The rest are real features — try adding, editing, deleting.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        <TabButton active={activeTab === 'sidebar'} onClick={() => setActiveTab('sidebar')}>
          Sidebar preview
        </TabButton>
        <TabButton active={activeTab === 'agent-index'} onClick={() => setActiveTab('agent-index')}>
          Agent settings
        </TabButton>
        <TabButton active={activeTab === 'faqs'} onClick={() => setActiveTab('faqs')}>
          FAQs
        </TabButton>
        <TabButton active={activeTab === 'rules'} onClick={() => setActiveTab('rules')}>
          Rules
        </TabButton>
        <TabButton active={activeTab === 'capture'} onClick={() => setActiveTab('capture')}>
          Capture fields
        </TabButton>
        <TabButton active={activeTab === 'goals'} onClick={() => setActiveTab('goals')}>
          Smart goals
        </TabButton>
        <TabButton active={activeTab === 'pronunciations'} onClick={() => setActiveTab('pronunciations')}>
          Pronunciations
        </TabButton>
      </nav>

      {activeTab === 'sidebar' && <SidebarPreviewSection />}
      {activeTab === 'agent-index' && <AgentSettingsIndexSection onPick={(t) => setActiveTab(t)} />}
      {activeTab === 'faqs' && <FaqsSection />}
      {activeTab === 'rules' && <RulesSection />}
      {activeTab === 'capture' && <SmartQuestionsSection />}
      {activeTab === 'goals' && <SmartGoalsSection />}
      {activeTab === 'pronunciations' && <PronunciationsSection />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-4 py-2 text-sm font-medium transition ${
        active
          ? 'bg-slate-100 text-slate-900'
          : 'border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function SectionCard({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">{title}</h2>
          {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-slate-50 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ FAQs */

function FaqsSection() {
  const [faqs, setFaqs] = useState<Faq[]>(seedFaqs);
  const [draftQuestion, setDraftQuestion] = useState('');
  const [draftAnswer, setDraftAnswer] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return faqs;
    return faqs.filter(
      (f) => f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q),
    );
  }, [faqs, filter]);

  const handleSave = () => {
    const question = draftQuestion.trim();
    const answer = draftAnswer.trim();
    if (!question || !answer) return;
    if (editingId) {
      setFaqs((prev) => prev.map((f) => (f.id === editingId ? { ...f, question, answer } : f)));
      setEditingId(null);
    } else {
      setFaqs((prev) => [{ id: newId(), question, answer }, ...prev]);
    }
    setDraftQuestion('');
    setDraftAnswer('');
  };

  const handleEdit = (faq: Faq) => {
    setEditingId(faq.id);
    setDraftQuestion(faq.question);
    setDraftAnswer(faq.answer);
  };

  const handleDelete = (id: string) => {
    setFaqs((prev) => prev.filter((f) => f.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setDraftQuestion('');
      setDraftAnswer('');
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setDraftQuestion('');
    setDraftAnswer('');
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title={editingId ? 'Edit FAQ' : 'Add a new FAQ'}
        description="When a caller asks something the agent can't book directly, it will draw the answer from this list."
      >
        <div className="space-y-3">
          <input
            type="text"
            value={draftQuestion}
            onChange={(e) => setDraftQuestion(e.target.value)}
            placeholder="What customers typically ask, e.g. 'Do you take card payments?'"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
          <textarea
            value={draftAnswer}
            onChange={(e) => setDraftAnswer(e.target.value)}
            rows={3}
            placeholder="The exact answer your agent should give. Keep it short and natural."
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={handleSave} disabled={!draftQuestion.trim() || !draftAnswer.trim()}>
              {editingId ? 'Save changes' : 'Add FAQ'}
            </PrimaryButton>
            {editingId && <SecondaryButton onClick={handleCancelEdit}>Cancel</SecondaryButton>}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={`Saved FAQs (${faqs.length})`}
        description="Drag-to-reorder coming later. For now, newest appears at the top."
        action={
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter FAQs..."
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
        }
      >
        {filtered.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
            {faqs.length === 0
              ? 'No FAQs yet. Add the first one above.'
              : 'No FAQs match that filter.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {filtered.map((faq) => (
              <li key={faq.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium text-slate-100">Q: {faq.question}</p>
                    <p className="text-sm text-slate-400">A: {faq.answer}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <SecondaryButton onClick={() => handleEdit(faq)}>Edit</SecondaryButton>
                    <button
                      type="button"
                      onClick={() => handleDelete(faq.id)}
                      className="rounded-md border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-300 transition hover:border-rose-400 hover:text-rose-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ----------------------------------------------------------------- Rules */

function RulesSection() {
  const [rules, setRules] = useState<AgentRule[]>(seedRules);
  const [draftText, setDraftText] = useState('');
  const [draftPriority, setDraftPriority] = useState<RulePriority>('normal');

  const handleAdd = () => {
    const text = draftText.trim();
    if (!text) return;
    setRules((prev) => [
      ...prev,
      { id: newId(), text, priority: draftPriority, enabled: true },
    ]);
    setDraftText('');
    setDraftPriority('normal');
  };

  const handleToggle = (id: string) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  const handleDelete = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleMove = (id: string, direction: -1 | 1) => {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx === -1) return prev;
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Add a behavioural rule"
        description="Constraints the agent must follow on every call. Higher priority rules sit at the top of the system prompt."
      >
        <div className="space-y-3">
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={2}
            placeholder={`e.g. "Always confirm the customer's email before ending the call"`}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs uppercase tracking-wide text-slate-400">Priority</label>
            <div className="flex gap-2">
              {(['high', 'normal', 'low'] as RulePriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDraftPriority(p)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                    draftPriority === p
                      ? 'border-slate-300 bg-slate-100 text-slate-900'
                      : 'border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {priorityLabels[p]}
                </button>
              ))}
            </div>
            <div className="ml-auto">
              <PrimaryButton onClick={handleAdd} disabled={!draftText.trim()}>
                Add rule
              </PrimaryButton>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={`Active rules (${rules.filter((r) => r.enabled).length} of ${rules.length})`}
        description="Order matters. Use the arrows to push the most important rules to the top."
      >
        {rules.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
            No rules yet. Add the first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {rules.map((rule, idx) => (
              <li
                key={rule.id}
                className={`flex items-start gap-3 rounded-lg border p-3 transition ${
                  rule.enabled ? 'border-slate-800 bg-slate-950/60' : 'border-slate-800 bg-slate-950/30 opacity-60'
                }`}
              >
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => handleMove(rule.id, -1)}
                    disabled={idx === 0}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 disabled:opacity-30"
                    aria-label="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMove(rule.id, 1)}
                    disabled={idx === rules.length - 1}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 disabled:opacity-30"
                    aria-label="Move down"
                  >
                    ▼
                  </button>
                </div>
                <div className="flex-1 space-y-2">
                  <p className="text-sm text-slate-100">{rule.text}</p>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${priorityStyles[rule.priority]}`}
                  >
                    {priorityLabels[rule.priority]} priority
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule.id)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900"
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => handleDelete(rule.id)}
                    className="rounded-md border border-rose-500/40 px-2 py-1 text-xs font-medium text-rose-300 transition hover:border-rose-400 hover:text-rose-200"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* -------------------------------------------------------- Smart Questions */

function SmartQuestionsSection() {
  const [fields, setFields] = useState<CaptureField[]>(defaultCaptureFields);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftType, setDraftType] = useState<CaptureFieldType>('text');
  const [draftHelp, setDraftHelp] = useState('');

  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setFields(preset.fields.map((f) => ({ ...f, id: newId() })));
  };

  const updateField = (id: string, change: Partial<CaptureField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...change } : f)));
  };

  const removeField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  const moveField = (id: string, direction: -1 | 1) => {
    setFields((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx === -1) return prev;
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleAddCustom = () => {
    const label = draftLabel.trim();
    if (!label) return;
    const key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    setFields((prev) => [
      ...prev,
      {
        id: newId(),
        key: key || `custom_${prev.length + 1}`,
        label,
        type: draftType,
        required: false,
        enabled: true,
        isCustom: true,
        helpText: draftHelp.trim() || undefined,
      },
    ]);
    setDraftLabel('');
    setDraftType('text');
    setDraftHelp('');
    setShowAddCustom(false);
  };

  const enabledCount = fields.filter((f) => f.enabled).length;
  const requiredCount = fields.filter((f) => f.enabled && f.required).length;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Start from a preset"
        description="Pick a starting set, then tweak. Inspired by Jodie's smart-goal presets but tuned for garage workflows."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-950/40 p-4 text-left transition hover:border-slate-500 hover:bg-slate-950"
            >
              <span className="text-sm font-semibold text-slate-100">{preset.name}</span>
              <span className="text-xs text-slate-400">{preset.description}</span>
              <span className="mt-auto text-xs text-slate-500">{preset.fields.length} fields</span>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={`Fields collected (${enabledCount} enabled, ${requiredCount} required)`}
        description="What the agent will ask each caller. Toggle off the fields you don't need. Order is the order it asks."
        action={
          <SecondaryButton onClick={() => setShowAddCustom((v) => !v)}>
            {showAddCustom ? 'Cancel' : 'Add custom field'}
          </SecondaryButton>
        }
      >
        {showAddCustom && (
          <div className="mb-4 space-y-3 rounded-lg border border-slate-700 bg-slate-950 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs uppercase tracking-wide text-slate-400">
                Label
                <input
                  type="text"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="e.g. Loyalty number"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
                />
              </label>
              <label className="space-y-1 text-xs uppercase tracking-wide text-slate-400">
                Type
                <select
                  value={draftType}
                  onChange={(e) => setDraftType(e.target.value as CaptureFieldType)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                >
                  {Object.entries(fieldTypeLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-xs uppercase tracking-wide text-slate-400">
              Help text (optional)
              <input
                type="text"
                value={draftHelp}
                onChange={(e) => setDraftHelp(e.target.value)}
                placeholder='e.g. "Found on the back of the loyalty card"'
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
              />
            </label>
            <div className="flex justify-end">
              <PrimaryButton onClick={handleAddCustom} disabled={!draftLabel.trim()}>
                Add field
              </PrimaryButton>
            </div>
          </div>
        )}

        {fields.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
            No fields configured. Pick a preset above to start.
          </p>
        ) : (
          <ul className="space-y-2">
            {fields.map((field, idx) => (
              <CaptureFieldRow
                key={field.id}
                field={field}
                isFirst={idx === 0}
                isLast={idx === fields.length - 1}
                onChange={(change) => updateField(field.id, change)}
                onMoveUp={() => moveField(field.id, -1)}
                onMoveDown={() => moveField(field.id, 1)}
                onRemove={() => removeField(field.id)}
              />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function CaptureFieldRow({
  field,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  field: CaptureField;
  isFirst: boolean;
  isLast: boolean;
  onChange: (change: Partial<CaptureField>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const handleTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onChange({ type: e.target.value as CaptureFieldType });
  };

  return (
    <li
      className={`grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 rounded-lg border p-3 transition ${
        field.enabled ? 'border-slate-800 bg-slate-950/60' : 'border-slate-800 bg-slate-950/30 opacity-60'
      }`}
    >
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 disabled:opacity-30"
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 disabled:opacity-30"
          aria-label="Move down"
        >
          ▼
        </button>
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-100">{field.label}</p>
          {field.isCustom && (
            <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200">
              Custom
            </span>
          )}
        </div>
        <p className="font-mono text-xs text-slate-500">{field.key}</p>
        {field.helpText && <p className="text-xs text-slate-400">Hint: {field.helpText}</p>}
      </div>
      <select
        value={field.type}
        onChange={handleTypeChange}
        className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        disabled={!field.isCustom}
        title={field.isCustom ? '' : 'Type is fixed for built-in fields'}
      >
        {Object.entries(fieldTypeLabels).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-3 text-xs text-slate-300">
        <label className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900"
            disabled={!field.enabled}
          />
          Required
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={field.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900"
          />
          Enabled
        </label>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={!field.isCustom}
        title={field.isCustom ? 'Remove this custom field' : 'Built-in fields can be disabled but not removed'}
        className="rounded-md border border-rose-500/40 px-2 py-1 text-xs font-medium text-rose-300 transition hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        Remove
      </button>
    </li>
  );
}

/* ------------------------------------------------------- Sidebar Preview */

const currentSidebar: Array<{ label: string; sub?: string }> = [
  { label: 'Dashboard' },
  { label: 'Calls' },
  { label: 'Messages', sub: '1 unread' },
  { label: 'Outbound' },
  { label: 'Templates' },
  { label: 'Agent Configurations' },
  { label: 'Team' },
  { label: 'Integrations' },
  { label: 'Observability' },
  { label: 'Admin' },
];

type ProposedItem = { label: string; children?: string[] };
const proposedSidebar: { group: string; items: ProposedItem[] }[] = [
  {
    group: 'Primary',
    items: [
      { label: 'Dashboard' },
      { label: 'Calls' },
      { label: 'Messages' },
      { label: 'Customers' },
    ],
  },
  {
    group: 'Settings',
    items: [
      {
        label: 'Agent',
        children: ['Greeting', 'FAQs', 'Rules', 'Capture fields', 'Smart goals', 'Pronunciations', 'Knowledge'],
      },
      { label: 'Channels & integrations', children: ['WhatsApp', 'Facebook / Instagram', 'Garage Hive', 'Tyresoft', 'HubSpot', 'Webhooks'] },
      { label: 'Team' },
      { label: 'Notifications' },
      { label: 'Billing' },
      { label: 'Profile' },
    ],
  },
  {
    group: 'Admin (staff only)',
    items: [{ label: 'Observability' }, { label: 'Admin' }],
  },
];

function SidebarPreviewSection() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Sidebar collapse: 10 → 4 primary + grouped settings"
        description="Today's sidebar shows 10 flat items. Jodie has 4 primary surfaces and groups the rest under Settings. Same features, fewer top-level decisions."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-xs uppercase tracking-wide text-slate-500">Today</h3>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <ul className="space-y-1.5">
                {currentSidebar.map((item) => (
                  <li key={item.label} className="flex items-center justify-between rounded px-2 py-1.5 text-sm text-slate-300">
                    <span>{item.label}</span>
                    {item.sub && (
                      <span className="rounded-full bg-rose-500/80 px-2 py-0.5 text-xs text-white">{item.sub}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs uppercase tracking-wide text-slate-500">Proposed</h3>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <div className="space-y-4">
                {proposedSidebar.map((group) => (
                  <div key={group.group} className="space-y-1.5">
                    <p className="px-2 text-xs uppercase tracking-wide text-slate-500">{group.group}</p>
                    <ul className="space-y-0.5">
                      {group.items.map((item) => (
                        <li key={item.label}>
                          <div className="rounded px-2 py-1.5 text-sm text-slate-200">{item.label}</div>
                          {item.children && (
                            <ul className="ml-4 space-y-0.5 border-l border-slate-800 pl-3">
                              {item.children.map((child) => (
                                <li key={child} className="rounded px-2 py-1 text-xs text-slate-400">
                                  {child}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4 md:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Primary surfaces</p>
            <p className="text-2xl font-semibold text-slate-100">4</p>
            <p className="text-xs text-slate-500">(was 10 flat items)</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Agent settings</p>
            <p className="text-2xl font-semibold text-slate-100">7 sub-pages</p>
            <p className="text-xs text-slate-500">(was one 1,500-line page)</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Staff-only</p>
            <p className="text-2xl font-semibold text-slate-100">Hidden</p>
            <p className="text-xs text-slate-500">unless RECEPTIONMATE_STAFF</p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------- Agent Settings Index */

type AgentSettingTile = {
  key: TabKey | null;
  title: string;
  description: string;
  status: string;
  ready: boolean;
};

const agentTiles: AgentSettingTile[] = [
  {
    key: null,
    title: 'Greeting',
    description: 'Opening line, tone, voice, response speed.',
    status: 'In current agent-configurations page',
    ready: false,
  },
  {
    key: 'faqs',
    title: 'FAQs',
    description: "Answer common caller questions the agent can't book directly.",
    status: '3 sample FAQs configured',
    ready: true,
  },
  {
    key: 'rules',
    title: 'Rules',
    description: 'Hard constraints the agent must follow on every call.',
    status: '4 sample rules configured',
    ready: true,
  },
  {
    key: 'capture',
    title: 'Capture fields',
    description: 'Choose what details the agent collects from each caller.',
    status: '8 fields, 5 enabled',
    ready: true,
  },
  {
    key: 'goals',
    title: 'Smart goals',
    description: 'What outcomes the agent should drive each call toward.',
    status: '3 sample goals configured',
    ready: true,
  },
  {
    key: 'pronunciations',
    title: 'Pronunciations',
    description: 'Phonetic overrides for garage names, brands, services.',
    status: '3 sample pronunciations',
    ready: true,
  },
  {
    key: null,
    title: 'Knowledge',
    description: 'Website scan + uploaded documents the agent draws from.',
    status: 'In current agent-configurations page',
    ready: false,
  },
];

function AgentSettingsIndexSection({ onPick }: { onPick: (tab: TabKey) => void }) {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Agent settings — split into 7 focused pages"
        description="Today's single agent-configurations page becomes seven sub-pages. Click any ready tile to jump there."
      >
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {agentTiles.map((tile) => {
            const clickable = tile.ready && tile.key;
            return (
              <button
                key={tile.title}
                type="button"
                onClick={() => clickable && tile.key && onPick(tile.key)}
                disabled={!clickable}
                className={`rounded-lg border p-4 text-left transition ${
                  clickable
                    ? 'border-slate-700 bg-slate-950/60 hover:border-slate-500 hover:bg-slate-950'
                    : 'cursor-not-allowed border-slate-800 bg-slate-950/30 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">{tile.title}</h3>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                      tile.ready
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-slate-700 bg-slate-900 text-slate-400'
                    }`}
                  >
                    {tile.ready ? 'Preview ready' : 'Stays put for now'}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-400">{tile.description}</p>
                <p className="mt-3 text-xs text-slate-500">{tile.status}</p>
              </button>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}

/* --------------------------------------------------------- Smart Goals */

type SmartGoal = {
  id: string;
  title: string;
  description: string;
  priority: number;
  enabled: boolean;
};

const seedGoals: SmartGoal[] = [
  {
    id: newId(),
    title: 'Book a slot',
    description: 'If the caller wants a service we offer and a slot is available, book it before they hang up.',
    priority: 1,
    enabled: true,
  },
  {
    id: newId(),
    title: 'Qualify lead for callback',
    description: "If the caller needs work we can't book on the call (custom quote, complex job), capture details and flag for a human callback within 1 working hour.",
    priority: 2,
    enabled: true,
  },
  {
    id: newId(),
    title: 'Resolve simple questions without escalation',
    description: 'Answer FAQ-style questions from the knowledge base. Only escalate when the answer is genuinely unknown or the caller insists.',
    priority: 3,
    enabled: true,
  },
];

function SmartGoalsSection() {
  const [goals, setGoals] = useState<SmartGoal[]>(seedGoals);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  const handleAdd = () => {
    const title = draftTitle.trim();
    const description = draftDescription.trim();
    if (!title || !description) return;
    setGoals((prev) => [
      ...prev,
      { id: newId(), title, description, priority: prev.length + 1, enabled: true },
    ]);
    setDraftTitle('');
    setDraftDescription('');
  };

  const handleToggle = (id: string) => {
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)));
  };

  const handleDelete = (id: string) => {
    setGoals((prev) => prev.filter((g) => g.id !== id));
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="What should the agent achieve?"
        description="Smart goals are outcomes — what success looks like for a call. Distinct from Rules (constraints) and Capture Fields (data collection)."
      >
        <div className="space-y-3">
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Goal title, e.g. 'Confirm the booking deposit'"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
          <textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={2}
            placeholder="When and how the agent should pursue this goal. Be specific so the agent knows when to apply it."
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
          <div className="flex justify-end">
            <PrimaryButton onClick={handleAdd} disabled={!draftTitle.trim() || !draftDescription.trim()}>
              Add goal
            </PrimaryButton>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={`Active goals (${goals.filter((g) => g.enabled).length} of ${goals.length})`}
        description="Goals are presented to the agent in priority order — top goals override lower ones when they conflict."
      >
        {goals.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
            No goals yet. Add the first one above.
          </p>
        ) : (
          <ul className="space-y-3">
            {goals.map((goal, idx) => (
              <li
                key={goal.id}
                className={`rounded-lg border p-4 transition ${
                  goal.enabled ? 'border-slate-800 bg-slate-950/60' : 'border-slate-800 bg-slate-950/30 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs font-mono text-slate-400">
                        #{idx + 1}
                      </span>
                      <h3 className="text-sm font-semibold text-slate-100">{goal.title}</h3>
                    </div>
                    <p className="text-sm text-slate-400">{goal.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={goal.enabled}
                        onChange={() => handleToggle(goal.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900"
                      />
                      Enabled
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDelete(goal.id)}
                      className="rounded-md border border-rose-500/40 px-2 py-1 text-xs font-medium text-rose-300 transition hover:border-rose-400 hover:text-rose-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------ Pronunciations */

type Pronunciation = {
  id: string;
  original: string;
  phonetic: string;
  example?: string;
};

const seedPronunciations: Pronunciation[] = [
  {
    id: newId(),
    original: 'EAC Telford',
    phonetic: 'ee ay see Telford',
    example: 'Spelled E-A-C — pronounced as separate letters, not the word "eek".',
  },
  {
    id: newId(),
    original: 'C&G Auto Repairs',
    phonetic: 'C and G Auto Repairs',
    example: 'Say "and" instead of reading the ampersand.',
  },
  {
    id: newId(),
    original: 'Tyresoft',
    phonetic: 'Tyre soft',
    example: "Two distinct syllables — not 'tyer-soft'.",
  },
];

function PronunciationsSection() {
  const [items, setItems] = useState<Pronunciation[]>(seedPronunciations);
  const [draftOriginal, setDraftOriginal] = useState('');
  const [draftPhonetic, setDraftPhonetic] = useState('');
  const [draftExample, setDraftExample] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleSave = () => {
    const original = draftOriginal.trim();
    const phonetic = draftPhonetic.trim();
    if (!original || !phonetic) return;
    const example = draftExample.trim() || undefined;
    if (editingId) {
      setItems((prev) => prev.map((p) => (p.id === editingId ? { ...p, original, phonetic, example } : p)));
      setEditingId(null);
    } else {
      setItems((prev) => [{ id: newId(), original, phonetic, example }, ...prev]);
    }
    setDraftOriginal('');
    setDraftPhonetic('');
    setDraftExample('');
  };

  const handleEdit = (item: Pronunciation) => {
    setEditingId(item.id);
    setDraftOriginal(item.original);
    setDraftPhonetic(item.phonetic);
    setDraftExample(item.example ?? '');
  };

  const handleCancel = () => {
    setEditingId(null);
    setDraftOriginal('');
    setDraftPhonetic('');
    setDraftExample('');
  };

  const handleDelete = (id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
    if (editingId === id) handleCancel();
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title={editingId ? 'Edit pronunciation' : 'Add a pronunciation override'}
        description='Tell the agent how to say specific words. Useful for branded names ("EAC Telford"), acronyms ("MOT"), and unusual spellings.'
      >
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs uppercase tracking-wide text-slate-400">
              Original text
              <input
                type="text"
                value={draftOriginal}
                onChange={(e) => setDraftOriginal(e.target.value)}
                placeholder='e.g. "EAC Telford"'
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
              />
            </label>
            <label className="space-y-1 text-xs uppercase tracking-wide text-slate-400">
              Spoken as
              <input
                type="text"
                value={draftPhonetic}
                onChange={(e) => setDraftPhonetic(e.target.value)}
                placeholder='e.g. "ee ay see Telford"'
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
              />
            </label>
          </div>
          <label className="block space-y-1 text-xs uppercase tracking-wide text-slate-400">
            Note (optional)
            <input
              type="text"
              value={draftExample}
              onChange={(e) => setDraftExample(e.target.value)}
              placeholder="Why this matters, or when to apply it"
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={handleSave} disabled={!draftOriginal.trim() || !draftPhonetic.trim()}>
              {editingId ? 'Save changes' : 'Add pronunciation'}
            </PrimaryButton>
            {editingId && <SecondaryButton onClick={handleCancel}>Cancel</SecondaryButton>}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={`Saved pronunciations (${items.length})`}
        description="Applied before TTS — the agent will speak the phonetic version while keeping the original in transcripts and emails."
      >
        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
            No pronunciations yet. Add the first one above.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <div className="grid gap-1 md:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Original</p>
                        <p className="text-sm font-medium text-slate-100">{item.original}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Spoken as</p>
                        <p className="font-mono text-sm text-emerald-200">{item.phonetic}</p>
                      </div>
                    </div>
                    {item.example && <p className="text-xs text-slate-400">{item.example}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <SecondaryButton onClick={() => handleEdit(item)}>Edit</SecondaryButton>
                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="rounded-md border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-300 transition hover:border-rose-400 hover:text-rose-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, FaqItem } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_FAQS = 30;

export default function FaqsTab({ config, save, isSaving }: Props) {
  const [faqs, setFaqs] = useState<FaqItem[]>(config.faqs ?? []);

  useEffect(() => {
    setFaqs(config.faqs ?? []);
  }, [config.faqs]);

  const addFaq = () => {
    if (faqs.length >= MAX_FAQS) return;
    setFaqs((prev) => [...prev, { question: '', answer: '', active: true }]);
  };
  const removeFaq = (idx: number) => setFaqs((prev) => prev.filter((_, i) => i !== idx));
  const updateFaq = (idx: number, patch: Partial<FaqItem>) =>
    setFaqs((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  const handleSave = () => {
    void save({ faqs: faqs.filter((f) => f.question.trim() && f.answer.trim()) });
  };

  return (
    <TabShell
      title="F&Qs"
      description="Questions callers ask all the time, with your standard answers. The agent uses these word-for-word so the answers stay consistent."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">FAQs</span>
          <span className="text-xs text-slate-500">
            {faqs.length} / {MAX_FAQS}
          </span>
        </div>

        {faqs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            No FAQs yet. Click &ldquo;Add FAQ&rdquo; to add one.
          </div>
        ) : (
          <ul className="space-y-3">
            {faqs.map((faq, idx) => (
              <li key={idx} className="rounded-lg border border-slate-200 bg-white p-3">
                <input
                  type="text"
                  value={faq.question}
                  onChange={(e) => updateFaq(idx, { question: e.target.value })}
                  placeholder="e.g. Do you take walk-ins?"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <textarea
                  value={faq.answer}
                  onChange={(e) => updateFaq(idx, { answer: e.target.value })}
                  rows={2}
                  placeholder="Yes — drop your vehicle off any time between 8 and 10am."
                  className="mt-2 w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <div className="mt-2 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={faq.active}
                      onChange={(e) => updateFaq(idx, { active: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    onClick={() => removeFaq(idx)}
                    className="text-xs font-medium text-rose-600 hover:text-rose-700"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={addFaq}
          disabled={faqs.length >= MAX_FAQS}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Add FAQ
        </button>
      </div>
    </TabShell>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import { SERVICE_CATALOGUE, SERVICE_GROUPS } from '../../lib/servicesCatalogue';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_CUSTOM = 20;

/**
 * What work this garage does.
 *
 * Every service starts ticked, because most garages do most of this and un-ticking the few
 * exceptions is less work than ticking twenty-six boxes. Nothing is claimed on the garage's
 * behalf until they press save: while `servicesOffered` is null the agent still takes a
 * message when a caller asks whether a job is possible, which is what it did before this tab
 * existed. The banner says so.
 */
export default function ServicesTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Services',
      description:
        'What work you do. The agent answers “do you do timing chains?” from this list, and never offers work you have un-ticked.',
      unsetTitle: 'Not saved yet',
      unsetBody:
        'Everything is ticked to start you off. Un-tick anything you do not do, then save. Until you save, the agent takes a message whenever a caller asks whether you do a particular job.',
      savedBody:
        'Un-ticked work is work the agent will say you do not do. It will not offer it and will not book it.',
      selectAll: 'Tick everything',
      clearAll: 'Un-tick everything',
      countLab: (n: number, total: number) => `${n} of ${total} ticked`,
      customTitle: 'Anything else you do',
      customHint:
        'Add work in your own words — remapping, LPG conversions, classic car restoration. The agent matches a caller’s words against exactly what you type, so write it the way a customer would say it.',
      customPlaceholder: 'e.g. Remapping',
      add: 'Add',
      remove: 'Remove',
      groups: {
        'Servicing & MOT': 'Servicing & MOT',
        Repairs: 'Repairs',
        'Tyres & wheels': 'Tyres & wheels',
        'Diagnostics & electrics': 'Diagnostics & electrics',
        'Bodywork & glass': 'Bodywork & glass',
        'Vehicle types': 'Vehicle types',
        'What you offer': 'What you offer',
      } as Record<string, string>,
    },
    fr: {
      title: 'Services',
      description:
        'Les travaux que vous réalisez. L’agent répond à « faites-vous les chaînes de distribution ? » à partir de cette liste, et ne propose jamais un travail que vous avez décoché.',
      unsetTitle: 'Pas encore enregistré',
      unsetBody:
        'Tout est coché pour commencer. Décochez ce que vous ne faites pas, puis enregistrez. Avant l’enregistrement, l’agent prend un message dès qu’un appelant demande si vous réalisez un travail donné.',
      savedBody:
        'Un travail décoché est un travail que l’agent dira que vous ne faites pas. Il ne le proposera pas et ne le réservera pas.',
      selectAll: 'Tout cocher',
      clearAll: 'Tout décocher',
      countLabel: (n: number, total: number) => `${n} sur ${total} cochés`,
      countLab: (n: number, total: number) => `${n} sur ${total} cochés`,
      customTitle: 'Autres travaux que vous faites',
      customHint:
        'Ajoutez des travaux avec vos propres mots. L’agent compare les mots de l’appelant exactement à ce que vous écrivez.',
      customPlaceholder: 'p. ex. Reprogrammation',
      add: 'Ajouter',
      remove: 'Supprimer',
      groups: {
        'Servicing & MOT': 'Entretien et contrôle technique',
        Repairs: 'Réparations',
        'Tyres & wheels': 'Pneus et roues',
        'Diagnostics & electrics': 'Diagnostic et électricité',
        'Bodywork & glass': 'Carrosserie et vitrage',
        'Vehicle types': 'Types de véhicules',
        'What you offer': 'Ce que vous proposez',
      } as Record<string, string>,
    },
  }[lang] as {
    title: string; description: string; unsetTitle: string; unsetBody: string; savedBody: string;
    selectAll: string; clearAll: string; countLab: (n: number, total: number) => string;
    customTitle: string; customHint: string; customPlaceholder: string; add: string;
    remove: string; groups: Record<string, string>;
  };

  // null means this garage has never answered. Start every pill ticked, but remember which
  // state we came from so the banner can tell the truth about what the agent does right now.
  const neverAnswered = !Array.isArray(config.servicesOffered);
  const allKeys = useMemo(() => SERVICE_CATALOGUE.map((e) => e.key), []);

  const [offered, setOffered] = useState<string[]>(
    Array.isArray(config.servicesOffered) ? config.servicesOffered : allKeys,
  );
  const [custom, setCustom] = useState<string[]>(config.servicesCustom ?? []);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setOffered(Array.isArray(config.servicesOffered) ? config.servicesOffered : allKeys);
    setCustom(config.servicesCustom ?? []);
  }, [config.servicesOffered, config.servicesCustom, allKeys]);

  const ticked = new Set(offered);
  const toggle = (key: string) =>
    setOffered((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const addCustom = () => {
    const value = draft.trim();
    if (value.length < 2 || custom.length >= MAX_CUSTOM) return;
    if (custom.some((x) => x.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    setCustom([...custom, value]);
    setDraft('');
  };

  const onSave = () =>
    save({
      // Ordered by the catalogue so a saved row reads the same way every time.
      servicesOffered: allKeys.filter((k) => ticked.has(k)),
      servicesCustom: custom,
    });

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={onSave}
      isSaving={isSaving}
    >
      <div
        className={
          neverAnswered
            ? 'rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900'
            : 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600'
        }
      >
        {neverAnswered && <p className="font-semibold">{c.unsetTitle}</p>}
        <p className={neverAnswered ? 'mt-1' : ''}>{neverAnswered ? c.unsetBody : c.savedBody}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-slate-700">
          {c.countLab(offered.length, allKeys.length)}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => setOffered(allKeys)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {c.selectAll}
          </button>
          <button
            type="button"
            onClick={() => setOffered([])}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {c.clearAll}
          </button>
        </div>
      </div>

      {SERVICE_GROUPS.map((group) => {
        const entries = SERVICE_CATALOGUE.filter((e) => e.group === group);
        if (entries.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {c.groups[group] ?? group}
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {entries.map((entry) => {
                const on = ticked.has(entry.key);
                return (
                  <button
                    key={entry.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(entry.key)}
                    className={
                      on
                        ? 'rounded-full border border-brand-600 bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm'
                        : 'rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-slate-400 line-through hover:border-slate-300'
                    }
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="border-t border-slate-200 pt-5">
        <h3 className="text-sm font-semibold text-slate-900">{c.customTitle}</h3>
        <p className="mt-1 text-sm text-slate-500">{c.customHint}</p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={draft}
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder={c.customPlaceholder}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={draft.trim().length < 2 || custom.length >= MAX_CUSTOM}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {c.add}
          </button>
        </div>
        {custom.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {custom.map((value) => (
              <span
                key={value}
                className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-800"
              >
                {value}
                <button
                  type="button"
                  aria-label={`${c.remove} ${value}`}
                  onClick={() => setCustom(custom.filter((x) => x !== value))}
                  className="text-brand-600 hover:text-brand-800"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </TabShell>
  );
}

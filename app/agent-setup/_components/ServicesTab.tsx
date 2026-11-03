'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import {
  SERVICE_CATALOGUE,
  SERVICE_DEFAULTS,
  SERVICE_GROUPS,
} from '../../lib/servicesCatalogue';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_CUSTOM = 30;

/**
 * What work this garage does.
 *
 * The list is a list of what you DO. Removing a job takes it off that list, which is how the
 * agent learns to say no to it — so the gesture is a removal, not a tick. Everyday work starts
 * on the list; the specialist groups start off it, because a garage that saves this tab without
 * reading it must not end up claiming motorcycles.
 *
 * Nothing is claimed on the garage's behalf until they press save: while `servicesOffered` is
 * null the agent still takes a message when a caller asks whether a job is possible, which is
 * what it did before this tab existed. The banner says so.
 */
export default function ServicesTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Services',
      description:
        'What work you do. The agent answers “do you do timing chains?” from this list, and never offers work that is not on it.',
      unsetTitle: 'Not saved yet',
      unsetBody:
        'This is a starting point, not your answer. Remove anything you do not do, add anything missing, then save. Until you save, the agent takes a message whenever a caller asks whether you do a particular job.',
      savedBody:
        'Anything not on this list is work the agent will say you do not do. It will not offer it and will not book it.',
      youDo: 'What you do',
      youDont: 'Not on your list',
      youDontHint:
        'The agent will say you do not do these. Add one back if that is wrong.',
      nothing: 'Nothing on your list yet. Add the work you do from below.',
      count: (n: number) => `${n} on your list`,
      restore: 'Put everything back',
      customTitle: 'Add your own',
      customHint:
        'Work in your own words, if it is not above. The agent matches a caller’s words against exactly what you type, so write it the way a customer would say it.',
      customPlaceholder: 'e.g. Horsebox servicing',
      customGroup: 'Your own',
      add: 'Add',
      remove: 'Remove',
      addBack: 'Add',
      groups: {} as Record<string, string>,
    },
    fr: {
      title: 'Services',
      description:
        'Les travaux que vous réalisez. L’agent répond à « faites-vous les chaînes de distribution ? » à partir de cette liste, et ne propose jamais un travail qui n’y figure pas.',
      unsetTitle: 'Pas encore enregistré',
      unsetBody:
        'Ceci est un point de départ, pas votre réponse. Retirez ce que vous ne faites pas, ajoutez ce qui manque, puis enregistrez. Avant l’enregistrement, l’agent prend un message dès qu’un appelant demande si vous réalisez un travail donné.',
      savedBody:
        'Tout ce qui ne figure pas sur cette liste est un travail que l’agent dira que vous ne faites pas.',
      youDo: 'Ce que vous faites',
      youDont: 'Pas sur votre liste',
      youDontHint:
        'L’agent dira que vous ne faites pas ces travaux. Rajoutez-en un si c’est inexact.',
      nothing: 'Votre liste est vide. Ajoutez vos travaux ci-dessous.',
      count: (n: number) => `${n} sur votre liste`,
      restore: 'Tout remettre',
      customTitle: 'Ajouter les vôtres',
      customHint:
        'Des travaux avec vos propres mots. L’agent compare les mots de l’appelant exactement à ce que vous écrivez.',
      customPlaceholder: 'p. ex. Entretien de vans à chevaux',
      customGroup: 'Les vôtres',
      add: 'Ajouter',
      remove: 'Retirer',
      addBack: 'Ajouter',
      groups: {
        'Servicing & MOT': 'Entretien et contrôle technique',
        'Brakes, tyres & wheels': 'Freins, pneus et roues',
        'Engine & drivetrain': 'Moteur et transmission',
        'Fuel, exhaust & emissions': 'Carburant, échappement et émissions',
        'Cooling & air conditioning': 'Refroidissement et climatisation',
        'Steering & suspension': 'Direction et suspension',
        Electrical: 'Électricité',
        'Bodywork & glass': 'Carrosserie et vitrage',
        'Vehicle types': 'Types de véhicules',
        'What you offer': 'Ce que vous proposez',
      } as Record<string, string>,
    },
  }[lang];

  const neverAnswered = !Array.isArray(config.servicesOffered);
  const allKeys = useMemo(() => SERVICE_CATALOGUE.map((e) => e.key), []);

  const [offered, setOffered] = useState<string[]>(
    Array.isArray(config.servicesOffered) ? config.servicesOffered : SERVICE_DEFAULTS,
  );
  const [custom, setCustom] = useState<string[]>(config.servicesCustom ?? []);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setOffered(Array.isArray(config.servicesOffered) ? config.servicesOffered : SERVICE_DEFAULTS);
    setCustom(config.servicesCustom ?? []);
  }, [config.servicesOffered, config.servicesCustom]);

  const on = new Set(offered);
  const removed = SERVICE_CATALOGUE.filter((e) => !on.has(e.key));
  const label = (group: string) => c.groups[group] ?? group;

  const drop = (key: string) => setOffered((prev) => prev.filter((k) => k !== key));
  const put = (key: string) => setOffered((prev) => [...prev, key]);

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
      servicesOffered: allKeys.filter((k) => on.has(k)),
      servicesCustom: custom,
    });

  return (
    <TabShell title={c.title} description={c.description} onSave={onSave} isSaving={isSaving}>
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

      {/* What you do */}
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{c.youDo}</h3>
        <span className="text-sm text-slate-500">{c.count(offered.length + custom.length)}</span>
      </div>

      {offered.length + custom.length === 0 && (
        <p className="text-sm text-slate-500">{c.nothing}</p>
      )}

      {SERVICE_GROUPS.map((group) => {
        const entries = SERVICE_CATALOGUE.filter((e) => e.group === group && on.has(e.key));
        if (entries.length === 0) return null;
        return (
          <div key={group}>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {label(group)}
            </h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {entries.map((entry) => (
                <span
                  key={entry.key}
                  className="inline-flex items-center gap-2 rounded-full border border-brand-600 bg-brand-600 py-1.5 pl-3.5 pr-2 text-sm font-medium text-white shadow-sm"
                >
                  {entry.label}
                  <button
                    type="button"
                    aria-label={`${c.remove} ${entry.label}`}
                    title={c.remove}
                    onClick={() => drop(entry.key)}
                    className="rounded-full px-1 text-base leading-none text-white/70 hover:bg-white/20 hover:text-white"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        );
      })}

      {custom.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {c.customGroup}
          </h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {custom.map((value) => (
              <span
                key={value}
                className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 py-1.5 pl-3.5 pr-2 text-sm text-brand-800"
              >
                {value}
                <button
                  type="button"
                  aria-label={`${c.remove} ${value}`}
                  title={c.remove}
                  onClick={() => setCustom(custom.filter((x) => x !== value))}
                  className="rounded-full px-1 text-base leading-none text-brand-600 hover:bg-brand-600/10 hover:text-brand-800"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Add your own */}
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
      </div>

      {/* Not on your list */}
      {removed.length > 0 && (
        <div className="border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-sm font-semibold text-slate-900">{c.youDont}</h3>
            <button
              type="button"
              onClick={() => setOffered(allKeys)}
              className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {c.restore}
            </button>
          </div>
          <p className="mt-1 text-sm text-slate-500">{c.youDontHint}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {removed.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => put(entry.key)}
                title={`${c.addBack} ${entry.label}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-500 hover:border-brand-600 hover:text-brand-700"
              >
                <span aria-hidden>+</span>
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </TabShell>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, WeeklyOpeningHours } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const DAYS: (keyof WeeklyOpeningHours)[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function defaultHours(): WeeklyOpeningHours {
  return {
    monday: { open: '08:30', close: '18:00', closed: false },
    tuesday: { open: '08:30', close: '18:00', closed: false },
    wednesday: { open: '08:30', close: '18:00', closed: false },
    thursday: { open: '08:30', close: '18:00', closed: false },
    friday: { open: '08:30', close: '18:00', closed: false },
    saturday: { open: '09:00', close: '13:00', closed: false },
    sunday: { open: '00:00', close: '00:00', closed: true },
  };
}

export default function HoursTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Opening hours',
      description:
        "When the garage is open. The agent uses this to tell callers if you're currently open or closed.",
      days: {
        monday: 'Monday',
        tuesday: 'Tuesday',
        wednesday: 'Wednesday',
        thursday: 'Thursday',
        friday: 'Friday',
        saturday: 'Saturday',
        sunday: 'Sunday',
      } as Record<keyof WeeklyOpeningHours, string>,
      closed: 'Closed',
      open: 'Open',
      from: 'From',
      to: 'to',
      holidayLabel: 'Holiday closures',
      holidayPlaceholder: 'e.g. Closed Christmas Day and Boxing Day, reopening 2nd January',
      holidayHint: 'Free-text notes about upcoming closures. The agent will read this if asked.',
    },
    fr: {
      title: "Horaires d'ouverture",
      description:
        "Quand l'agence est ouverte. L'agent s'en sert pour indiquer aux appelants si vous êtes actuellement ouvert ou fermé.",
      days: {
        monday: 'Lundi',
        tuesday: 'Mardi',
        wednesday: 'Mercredi',
        thursday: 'Jeudi',
        friday: 'Vendredi',
        saturday: 'Samedi',
        sunday: 'Dimanche',
      } as Record<keyof WeeklyOpeningHours, string>,
      closed: 'Fermé',
      open: 'Ouvert',
      from: 'De',
      to: 'à',
      holidayLabel: 'Fermetures pour congés',
      holidayPlaceholder: 'p. ex. Fermé le 25 et 26 décembre, réouverture le 2 janvier',
      holidayHint:
        "Notes en texte libre sur les fermetures à venir. L'agent les lira si on lui demande.",
    },
  }[lang];
  const [hours, setHours] = useState<WeeklyOpeningHours>(
    config.weeklyOpeningHours ?? defaultHours()
  );
  const [holidayClosures, setHolidayClosures] = useState(
    config.holidayClosures ?? ''
  );

  useEffect(() => {
    setHours(config.weeklyOpeningHours ?? defaultHours());
    setHolidayClosures(config.holidayClosures ?? '');
  }, [config]);

  const updateDay = (
    day: keyof WeeklyOpeningHours,
    patch: Partial<WeeklyOpeningHours[keyof WeeklyOpeningHours]>
  ) => {
    setHours({
      ...hours,
      [day]: { ...hours[day], ...patch },
    });
  };

  const handleSave = () => {
    void save({
      weeklyOpeningHours: hours,
      holidayClosures,
    });
  };

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="space-y-2">
        {DAYS.map((key) => {
          const day = hours[key];
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <div className="w-24 shrink-0 text-sm font-medium text-slate-700">
                {c.days[key]}
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={!day.closed}
                  onChange={(e) => updateDay(key, { closed: !e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 bg-slate-100 text-brand-600 focus:ring-brand-600"
                />
                <span className="text-xs text-slate-500">
                  {day.closed ? c.closed : c.open}
                </span>
              </label>
              {!day.closed && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{c.from}</span>
                    <input
                      type="time"
                      value={day.open ?? ''}
                      onChange={(e) => updateDay(key, { open: e.target.value })}
                      className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{c.to}</span>
                    <input
                      type="time"
                      value={day.close ?? ''}
                      onChange={(e) => updateDay(key, { close: e.target.value })}
                      className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          {c.holidayLabel}
        </label>
        <textarea
          value={holidayClosures}
          onChange={(e) => setHolidayClosures(e.target.value)}
          rows={3}
          placeholder={c.holidayPlaceholder}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          {c.holidayHint}
        </p>
      </div>
    </TabShell>
  );
}

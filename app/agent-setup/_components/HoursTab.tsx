'use client';

import { useEffect, useState, useCallback } from 'react';
import type { AgentConfiguration, WeeklyOpeningHours } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

type BankHolidayEntry = { date: string; name: string };

const UK_BANK_HOLIDAYS_2026: BankHolidayEntry[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-05-04', name: 'Early May Bank Holiday' },
  { date: '2026-05-25', name: 'Spring Bank Holiday' },
  { date: '2026-08-31', name: 'Summer Bank Holiday' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-28', name: 'Boxing Day (substitute)' },
];

const UK_BANK_HOLIDAYS_2027: BankHolidayEntry[] = [
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-05-03', name: 'Early May Bank Holiday' },
  { date: '2027-05-31', name: 'Spring Bank Holiday' },
  { date: '2027-08-30', name: 'Summer Bank Holiday' },
  { date: '2027-12-27', name: 'Christmas Day (substitute)' },
  { date: '2027-12-28', name: 'Boxing Day (substitute)' },
];

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
      bankHolidayLabel: 'Bank holiday dates',
      bankHolidayHint: 'The agent will automatically tell callers the garage is closed on these dates.',
      addDate: 'Add',
      addUk2026: 'Add UK 2026',
      addUk2027: 'Add UK 2027',
      datePlaceholder: 'Holiday name',
      remove: 'Remove',
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
      bankHolidayLabel: 'Jours fériés',
      bankHolidayHint: "L'agent informera automatiquement les appelants que le garage est fermé à ces dates.",
      addDate: 'Ajouter',
      addUk2026: 'Ajouter UK 2026',
      addUk2027: 'Ajouter UK 2027',
      datePlaceholder: 'Nom du jour férié',
      remove: 'Supprimer',
    },
  }[lang];
  const [hours, setHours] = useState<WeeklyOpeningHours>(
    config.weeklyOpeningHours ?? defaultHours()
  );
  const [holidayClosures, setHolidayClosures] = useState(
    config.holidayClosures ?? ''
  );
  const [bankHolidayDates, setBankHolidayDates] = useState<BankHolidayEntry[]>(
    config.bankHolidayDates ?? []
  );
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');

  useEffect(() => {
    setHours(config.weeklyOpeningHours ?? defaultHours());
    setHolidayClosures(config.holidayClosures ?? '');
    setBankHolidayDates(config.bankHolidayDates ?? []);
  }, [config]);

  const addBankHoliday = useCallback((entry: BankHolidayEntry) => {
    setBankHolidayDates((prev) => {
      if (prev.some((e) => e.date === entry.date)) return prev;
      return [...prev, entry].sort((a, b) => a.date.localeCompare(b.date));
    });
  }, []);

  const removeBankHoliday = useCallback((date: string) => {
    setBankHolidayDates((prev) => prev.filter((e) => e.date !== date));
  }, []);

  const addPreset = useCallback((preset: BankHolidayEntry[]) => {
    setBankHolidayDates((prev) => {
      const existing = new Set(prev.map((e) => e.date));
      const merged = [...prev, ...preset.filter((e) => !existing.has(e.date))];
      return merged.sort((a, b) => a.date.localeCompare(b.date));
    });
  }, []);

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
      bankHolidayDates: bankHolidayDates.length > 0 ? bankHolidayDates : null,
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

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          {c.bankHolidayLabel}
        </label>

        {bankHolidayDates.length > 0 && (
          <div className="mb-3 space-y-1">
            {bankHolidayDates.map((entry) => (
              <div
                key={entry.date}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-slate-700">
                    {new Date(entry.date + 'T12:00:00').toLocaleDateString('en-GB', {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                  <span className="text-sm text-slate-500">{entry.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeBankHoliday(entry.date)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  {c.remove}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </div>
          <div>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={c.datePlaceholder}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </div>
          <button
            type="button"
            disabled={!newDate || !newName}
            onClick={() => {
              if (newDate && newName) {
                addBankHoliday({ date: newDate, name: newName });
                setNewDate('');
                setNewName('');
              }
            }}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {c.addDate}
          </button>
        </div>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => addPreset(UK_BANK_HOLIDAYS_2026)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {c.addUk2026}
          </button>
          <button
            type="button"
            onClick={() => addPreset(UK_BANK_HOLIDAYS_2027)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {c.addUk2027}
          </button>
        </div>

        <p className="mt-1 text-xs text-slate-500">
          {c.bankHolidayHint}
        </p>
      </div>
    </TabShell>
  );
}

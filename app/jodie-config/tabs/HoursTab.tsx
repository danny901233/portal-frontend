'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, WeeklyOpeningHours } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const DAYS: { key: keyof WeeklyOpeningHours; label: string }[] = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
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
      title="Opening hours"
      description="When the garage is open. The agent uses this to tell callers if you're currently open or closed."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="space-y-2">
        {DAYS.map(({ key, label }) => {
          const day = hours[key];
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-300/60 bg-slate-50 p-3"
            >
              <div className="w-24 shrink-0 text-sm font-medium text-slate-700">
                {label}
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={!day.closed}
                  onChange={(e) => updateDay(key, { closed: !e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 bg-slate-100 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-xs text-slate-500">
                  {day.closed ? 'Closed' : 'Open'}
                </span>
              </label>
              {!day.closed && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">From</span>
                    <input
                      type="time"
                      value={day.open ?? ''}
                      onChange={(e) => updateDay(key, { open: e.target.value })}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">to</span>
                    <input
                      type="time"
                      value={day.close ?? ''}
                      onChange={(e) => updateDay(key, { close: e.target.value })}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
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
          Holiday closures
        </label>
        <textarea
          value={holidayClosures}
          onChange={(e) => setHolidayClosures(e.target.value)}
          rows={3}
          placeholder="e.g. Closed Christmas Day and Boxing Day, reopening 2nd January"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          Free-text notes about upcoming closures. The agent will read this if asked.
        </p>
      </div>
    </TabShell>
  );
}

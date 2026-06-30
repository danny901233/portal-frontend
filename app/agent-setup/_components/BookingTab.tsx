'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function BookingTab({ config, save, isSaving }: Props) {
  const [allowBookings, setAllowBookings] = useState(config.allowBookings ?? false);
  const [bookingLeadTimeDays, setBookingLeadTimeDays] = useState(
    config.bookingLeadTimeDays ?? 1
  );
  const [enableSmsBookingLinks, setEnableSmsBookingLinks] = useState(
    config.enableSmsBookingLinks ?? true
  );
  const [enableDropOffBookings, setEnableDropOffBookings] = useState(
    config.enableDropOffBookings ?? false
  );
  const [dropOffMessage, setDropOffMessage] = useState(
    config.dropOffMessage ?? 'drop your vehicle off between 8am and half ten in the morning'
  );
  const [dropOffExcludeServices, setDropOffExcludeServices] = useState<string>(
    (config.dropOffExcludeServices ?? ['MOT']).join(', ')
  );
  const [allowFastFitOnly, setAllowFastFitOnly] = useState(
    config.allowFastFitOnly ?? false
  );

  useEffect(() => {
    setAllowBookings(config.allowBookings ?? false);
    setBookingLeadTimeDays(config.bookingLeadTimeDays ?? 1);
    setEnableSmsBookingLinks(config.enableSmsBookingLinks ?? true);
    setEnableDropOffBookings(config.enableDropOffBookings ?? false);
    setDropOffMessage(config.dropOffMessage ?? 'drop your vehicle off between 8am and half ten in the morning');
    setDropOffExcludeServices((config.dropOffExcludeServices ?? ['MOT']).join(', '));
    setAllowFastFitOnly(config.allowFastFitOnly ?? false);
  }, [config]);

  const handleSave = () => {
    const excludeList = dropOffExcludeServices
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void save({
      allowBookings,
      bookingLeadTimeDays,
      enableSmsBookingLinks,
      enableDropOffBookings,
      dropOffMessage,
      dropOffExcludeServices: excludeList,
      allowFastFitOnly,
    });
  };

  // The GarageHive (Automate) agent always books against the live diary and ignores this
  // toggle — it only applies to Assist garages. Flag that clearly so it isn't mistaken for
  // an off switch on Automate.
  const isAutomate = ['receptionmate-agent', 'receptionmate-agent-v3', 'GarageHive-agent'].includes(
    config.agentScript
  );

  return (
    <TabShell
      title="Booking behavior"
      description="How the agent handles booking requests."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <Toggle
        label="Allow the agent to offer bookings"
        hint="If off, the agent always takes a message instead of attempting to book."
        checked={allowBookings}
        onChange={setAllowBookings}
      />

      {isAutomate && (
        <p className="-mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This setting only applies to Assist agents. This garage uses the GarageHive (Automate)
          agent, which always books against your live diary — so this toggle has no effect here.
        </p>
      )}

      {allowBookings && (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Booking lead time (days)
          </label>
          <input
            type="number"
            min={1}
            max={30}
            value={bookingLeadTimeDays}
            onChange={(e) => setBookingLeadTimeDays(parseInt(e.target.value) || 1)}
            className="w-24 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
          <p className="mt-1 text-xs text-slate-500">
            Earliest the agent will offer to book a slot. Minimum 1 day.
          </p>
        </div>
      )}

      <Toggle
        label="Send SMS booking confirmation links"
        hint="If on, an SMS link is sent to the caller after the agent books or takes a message."
        checked={enableSmsBookingLinks}
        onChange={setEnableSmsBookingLinks}
      />

      <Toggle
        label="Enable drop-off bookings"
        hint="If on, the agent can offer drop-off appointments instead of timed bookings for certain services."
        checked={enableDropOffBookings}
        onChange={setEnableDropOffBookings}
      />

      {enableDropOffBookings && (
        <>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Drop-off message
            </label>
            <textarea
              value={dropOffMessage}
              onChange={(e) => setDropOffMessage(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <p className="mt-1 text-xs text-slate-500">
              What the agent tells callers about drop-offs.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Services that can&rsquo;t be drop-offs
            </label>
            <input
              type="text"
              value={dropOffExcludeServices}
              onChange={(e) => setDropOffExcludeServices(e.target.value)}
              placeholder="MOT, diagnostic"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <p className="mt-1 text-xs text-slate-500">
              Comma-separated list. The agent will always book these at a timed slot, never as drop-off.
              Default: <code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-700">MOT</code>.
            </p>
          </div>
        </>
      )}

      <Toggle
        label="Fast-fit services only"
        hint="If on, the agent only offers quick services (tyres, oil, basics) — full diagnostic / engine work is escalated."
        checked={allowFastFitOnly}
        onChange={setAllowFastFitOnly}
      />
    </TabShell>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      </div>
      <label className="relative inline-flex shrink-0 cursor-pointer items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <div className="h-6 w-11 rounded-full bg-slate-700 after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-slate-300 after:transition-all peer-checked:bg-brand-600 peer-checked:after:translate-x-full peer-checked:after:bg-white" />
      </label>
    </div>
  );
}

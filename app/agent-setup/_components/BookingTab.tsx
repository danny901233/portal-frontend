'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function BookingTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Booking behavior',
      description: 'How the agent handles booking requests.',
      allowLabel: 'Allow the agent to offer bookings',
      allowHint: 'If off, the agent always takes a message instead of attempting to book.',
      automateNote:
        'This setting only applies to Assist agents. This garage uses the GarageHive (Automate) agent, which always books against your live diary — so this toggle has no effect here.',
      leadTimeLabel: 'Booking lead time (days)',
      leadTimeHint: 'Earliest the agent will offer to book a slot. Minimum 1 day.',
      smsLabel: 'Send SMS booking confirmation links',
      smsHint: 'If on, an SMS link is sent to the caller after the agent books or takes a message.',
      dropOffLabel: 'Enable drop-off bookings',
      dropOffHint:
        'If on, the agent can offer drop-off appointments instead of timed bookings for certain services.',
      dropOffMsgLabel: 'Drop-off message',
      dropOffMsgHint: 'What the agent tells callers about drop-offs.',
      excludeLabel: 'Services that can’t be drop-offs',
      excludeHintBefore: 'Comma-separated list. The agent will always book these at a timed slot, never as drop-off. Default: ',
      fastFitLabel: 'Fast-fit services only',
      fastFitHint:
        'If on, the agent only offers quick services (tyres, oil, basics) — full diagnostic / engine work is escalated.',
      callerRecLabel: 'Caller recognition',
      callerRecHint:
        'On an inbound call, look the caller’s number up in Garage Hive and confirm the vehicle on file (“is it still the Focus?”) instead of asking for the reg. Needs Garage Hive connected.',
      advisoryLabel: 'Advisory upsells',
      advisoryHint:
        'When a customer books, the agent checks Garage Hive for outstanding health-check advisories on their vehicle and offers to add them. Needs Garage Hive connected.',
    },
    fr: {
      title: 'Comportement de réservation',
      description: "Comment l'agent gère les demandes de réservation.",
      allowLabel: "Autoriser l'agent à proposer des réservations",
      allowHint: "Si désactivé, l'agent prend toujours un message au lieu de tenter de réserver.",
      automateNote:
        "Ce paramètre ne s'applique qu'aux agents Assist. Cette agence utilise l'agent GarageHive (Automate), qui réserve toujours sur votre agenda en temps réel — ce bouton n'a donc aucun effet ici.",
      leadTimeLabel: 'Délai de réservation (jours)',
      leadTimeHint: "Le plus tôt où l'agent proposera de réserver un créneau. Minimum 1 jour.",
      smsLabel: 'Envoyer des liens de confirmation de réservation par SMS',
      smsHint:
        "Si activé, un lien SMS est envoyé à l'appelant après que l'agent a réservé ou pris un message.",
      dropOffLabel: 'Activer les réservations en dépôt',
      dropOffHint:
        "Si activé, l'agent peut proposer des rendez-vous en dépôt au lieu de réservations à horaire fixe pour certaines prestations.",
      dropOffMsgLabel: 'Message de dépôt',
      dropOffMsgHint: "Ce que l'agent indique aux appelants au sujet des dépôts.",
      excludeLabel: 'Prestations qui ne peuvent pas être en dépôt',
      excludeHintBefore: "Liste séparée par des virgules. L'agent réservera toujours ces prestations à un créneau horaire fixe, jamais en dépôt. Par défaut : ",
      fastFitLabel: 'Prestations rapides uniquement',
      fastFitHint:
        "Si activé, l'agent ne propose que des prestations rapides (pneus, vidange, entretien de base) — les diagnostics complets / travaux moteur sont escaladés.",
      callerRecLabel: "Reconnaissance de l'appelant",
      callerRecHint:
        "Lors d'un appel entrant, rechercher le numéro de l'appelant dans Garage Hive et confirmer le véhicule au dossier (« est-ce toujours la Focus ? ») au lieu de demander l'immatriculation. Nécessite Garage Hive connecté.",
      advisoryLabel: 'Ventes additionnelles de recommandations',
      advisoryHint:
        "Lorsqu'un client réserve, l'agent vérifie dans Garage Hive les recommandations de contrôle en attente sur son véhicule et propose de les ajouter. Nécessite Garage Hive connecté.",
    },
  }[lang];
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
  const [callerRecognitionEnabled, setCallerRecognitionEnabled] = useState(
    config.callerRecognitionEnabled ?? false
  );
  const [advisoryUpsellsEnabled, setAdvisoryUpsellsEnabled] = useState(
    config.advisoryUpsellsEnabled ?? false
  );

  useEffect(() => {
    setAllowBookings(config.allowBookings ?? false);
    setBookingLeadTimeDays(config.bookingLeadTimeDays ?? 1);
    setEnableSmsBookingLinks(config.enableSmsBookingLinks ?? true);
    setEnableDropOffBookings(config.enableDropOffBookings ?? false);
    setDropOffMessage(config.dropOffMessage ?? 'drop your vehicle off between 8am and half ten in the morning');
    setDropOffExcludeServices((config.dropOffExcludeServices ?? ['MOT']).join(', '));
    setAllowFastFitOnly(config.allowFastFitOnly ?? false);
    setCallerRecognitionEnabled(config.callerRecognitionEnabled ?? false);
    setAdvisoryUpsellsEnabled(config.advisoryUpsellsEnabled ?? false);
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
      callerRecognitionEnabled,
      advisoryUpsellsEnabled,
    });
  };

  // Caller recognition + advisory upsells only apply to the Garage Hive agent.
  const isGarageHiveAgent = ['receptionmate-agent-v3', 'GarageHive-agent'].includes(
    config.agentScript,
  );

  // The GarageHive (Automate) agent always books against the live diary and ignores this
  // toggle — it only applies to Assist garages. Flag that clearly so it isn't mistaken for
  // an off switch on Automate.
  const isAutomate = ['receptionmate-agent', 'receptionmate-agent-v3', 'GarageHive-agent', 'MMH-agent'].includes(
    config.agentScript
  );

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <Toggle
        label={c.allowLabel}
        hint={c.allowHint}
        checked={allowBookings}
        onChange={setAllowBookings}
      />

      {isAutomate && (
        <p className="-mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {c.automateNote}
        </p>
      )}

      {allowBookings && (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            {c.leadTimeLabel}
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
            {c.leadTimeHint}
          </p>
        </div>
      )}

      <Toggle
        label={c.smsLabel}
        hint={c.smsHint}
        checked={enableSmsBookingLinks}
        onChange={setEnableSmsBookingLinks}
      />

      <Toggle
        label={c.dropOffLabel}
        hint={c.dropOffHint}
        checked={enableDropOffBookings}
        onChange={setEnableDropOffBookings}
      />

      {enableDropOffBookings && (
        <>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              {c.dropOffMsgLabel}
            </label>
            <textarea
              value={dropOffMessage}
              onChange={(e) => setDropOffMessage(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <p className="mt-1 text-xs text-slate-500">
              {c.dropOffMsgHint}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              {c.excludeLabel}
            </label>
            <input
              type="text"
              value={dropOffExcludeServices}
              onChange={(e) => setDropOffExcludeServices(e.target.value)}
              placeholder="MOT, diagnostic"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <p className="mt-1 text-xs text-slate-500">
              {c.excludeHintBefore}<code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-700">MOT</code>.
            </p>
          </div>
        </>
      )}

      <Toggle
        label={c.fastFitLabel}
        hint={c.fastFitHint}
        checked={allowFastFitOnly}
        onChange={setAllowFastFitOnly}
      />

      {isGarageHiveAgent && (
        <>
          <div className="mt-6 border-t border-slate-200 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Garage Hive</p>
          </div>
          <Toggle
            label={c.callerRecLabel}
            hint={c.callerRecHint}
            checked={callerRecognitionEnabled}
            onChange={setCallerRecognitionEnabled}
          />
          <Toggle
            label={c.advisoryLabel}
            hint={c.advisoryHint}
            checked={advisoryUpsellsEnabled}
            onChange={setAdvisoryUpsellsEnabled}
          />
        </>
      )}
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

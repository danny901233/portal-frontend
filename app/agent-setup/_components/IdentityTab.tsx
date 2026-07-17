'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
  /** Read-only — the Twilio number callers dial. Managed by RM staff in /admin. */
  twilioNumber?: string | null;
}

export default function IdentityTab({ config, save, isSaving, twilioNumber }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Branch identity',
      description: "Tells the agent who it's representing. Used in the greeting and every prompt.",
      branchName: 'Branch name',
      branchNameHint: 'e.g. Riverside Motors — Reading',
      branchNameRequired: "Branch name is required so the agent knows who it's representing.",
      agentName: 'Agent name',
      agentNameHint: "What the agent calls itself on calls (e.g. the voice's name, or your own — like 'Jamie')",
      agentNamePlaceholder: 'e.g. Leah',
      phone: 'Phone number',
      phoneHint: 'The number the garage answers on',
      rmNumber: 'ReceptionMate number',
      rmNumberHint:
        'The number callers dial to reach the AI agent. Managed by ReceptionMate staff — get in touch if you need it changed.',
      notAssigned: 'Not assigned yet',
      email: 'Email address',
      emailHint: 'For booking confirmations + notifications',
      address: 'Branch address',
      addressHint: "Used when the caller asks where you're based",
      website: 'Website URL',
      websiteHint: 'Optional — used by the agent if it gets asked for the website',
    },
    fr: {
      title: "Identité de l'agence",
      description:
        "Indique à l'agent qui il représente. Utilisé dans le message d'accueil et chaque prompt.",
      branchName: "Nom de l'agence",
      branchNameHint: 'p. ex. Riverside Motors — Reading',
      branchNameRequired: "Le nom de l'agence est requis pour que l'agent sache qui il représente.",
      agentName: "Nom de l'agent",
      agentNameHint:
        "Le nom que l'agent utilise pour se présenter lors des appels (p. ex. le nom de la voix, ou le vôtre — comme « Jamie »)",
      agentNamePlaceholder: 'p. ex. Leah',
      phone: 'Numéro de téléphone',
      phoneHint: "Le numéro sur lequel l'agence répond",
      rmNumber: 'Numéro ReceptionMate',
      rmNumberHint:
        "Le numéro que les appelants composent pour joindre l'agent IA. Géré par l'équipe ReceptionMate — contactez-nous si vous devez le modifier.",
      notAssigned: 'Pas encore attribué',
      email: 'Adresse email',
      emailHint: 'Pour les confirmations de réservation et les notifications',
      address: "Adresse de l'agence",
      addressHint: "Utilisée lorsque l'appelant demande où vous êtes situé",
      website: 'URL du site web',
      websiteHint: "Facultatif — utilisé par l'agent si on lui demande le site web",
    },
  }[lang];
  const [branchName, setBranchName] = useState(config.branchName ?? '');
  const [agentName, setAgentName] = useState(config.agentName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(config.phoneNumber ?? '');
  const [emailAddress, setEmailAddress] = useState(config.emailAddress ?? '');
  const [branchAddress, setBranchAddress] = useState(config.branchAddress ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(config.websiteUrl ?? '');

  useEffect(() => {
    setBranchName(config.branchName ?? '');
    setAgentName(config.agentName ?? '');
    setPhoneNumber(config.phoneNumber ?? '');
    setEmailAddress(config.emailAddress ?? '');
    setBranchAddress(config.branchAddress ?? '');
    setWebsiteUrl(config.websiteUrl ?? '');
  }, [config]);

  const handleSave = () => {
    void save({
      branchName,
      agentName,
      phoneNumber,
      emailAddress,
      branchAddress,
      websiteUrl,
    });
  };

  const branchNameMissing = !branchName.trim();

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
      saveDisabled={branchNameMissing}
    >
      <Field label={c.branchName} required hint={c.branchNameHint}>
        <input
          type="text"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        {branchNameMissing && (
          <p className="mt-1 text-xs text-rose-600">
            {c.branchNameRequired}
          </p>
        )}
      </Field>

      <Field label={c.agentName} hint={c.agentNameHint}>
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder={c.agentNamePlaceholder}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label={c.phone} hint={c.phoneHint}>
        <input
          type="tel"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="+44 1234 567890"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field
        label={c.rmNumber}
        hint={c.rmNumberHint}
      >
        <input
          type="text"
          value={twilioNumber ?? c.notAssigned}
          readOnly
          aria-readonly
          className="w-full cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
        />
      </Field>

      <Field label={c.email} hint={c.emailHint}>
        <input
          type="email"
          value={emailAddress}
          onChange={(e) => setEmailAddress(e.target.value)}
          placeholder="hello@yourgarage.co.uk"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label={c.address} hint={c.addressHint}>
        <textarea
          value={branchAddress}
          onChange={(e) => setBranchAddress(e.target.value)}
          rows={2}
          placeholder="123 High Street, Reading, RG1 1AA"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label={c.website} hint={c.websiteHint}>
        <input
          type="url"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          placeholder="https://yourgarage.co.uk"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>
    </TabShell>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-1 text-rose-600">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

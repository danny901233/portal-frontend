'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function IdentityTab({ config, save, isSaving }: Props) {
  const [branchName, setBranchName] = useState(config.branchName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(config.phoneNumber ?? '');
  const [emailAddress, setEmailAddress] = useState(config.emailAddress ?? '');
  const [branchAddress, setBranchAddress] = useState(config.branchAddress ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(config.websiteUrl ?? '');

  useEffect(() => {
    setBranchName(config.branchName ?? '');
    setPhoneNumber(config.phoneNumber ?? '');
    setEmailAddress(config.emailAddress ?? '');
    setBranchAddress(config.branchAddress ?? '');
    setWebsiteUrl(config.websiteUrl ?? '');
  }, [config]);

  const handleSave = () => {
    void save({
      branchName,
      phoneNumber,
      emailAddress,
      branchAddress,
      websiteUrl,
    });
  };

  const branchNameMissing = !branchName.trim();

  return (
    <TabShell
      title="Branch identity"
      description="Tells the agent who it's representing. Used in the greeting and every prompt."
      onSave={handleSave}
      isSaving={isSaving}
      saveDisabled={branchNameMissing}
    >
      <Field label="Branch name" required hint="e.g. Riverside Motors — Reading">
        <input
          type="text"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        {branchNameMissing && (
          <p className="mt-1 text-xs text-rose-700">
            Branch name is required so the agent knows who it's representing.
          </p>
        )}
      </Field>

      <Field label="Phone number" hint="The number the garage answers on">
        <input
          type="tel"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="+44 1234 567890"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label="Email address" hint="For booking confirmations + notifications">
        <input
          type="email"
          value={emailAddress}
          onChange={(e) => setEmailAddress(e.target.value)}
          placeholder="hello@yourgarage.co.uk"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label="Branch address" hint="Used when the caller asks where you're based">
        <textarea
          value={branchAddress}
          onChange={(e) => setBranchAddress(e.target.value)}
          rows={2}
          placeholder="123 High Street, Reading, RG1 1AA"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </Field>

      <Field label="Website URL" hint="Optional — used by the agent if it gets asked for the website">
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
        {required && <span className="ml-1 text-rose-700">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

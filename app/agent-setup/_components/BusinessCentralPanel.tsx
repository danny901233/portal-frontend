'use client';

import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { getGarageId } from '../../lib/auth';

/**
 * Connect a garage to the Garage Hive Business Central API.
 *
 * A Garage Hive ACCOUNT is one BC environment (tenant + environment name); the branches inside it
 * are COMPANIES. JDK Group is the first of these — JDK Automotive, Ecotest and Great Hollands all
 * live in one environment and differ only by company.
 *
 * So the tenant and environment are typed once per garage and the company is PICKED from what BC
 * actually returns. Company ids are GUIDs, and a typo in one is indistinguishable from a
 * permissions problem when a reminder silently fails three days later. Fetching the list also
 * proves the app has access before anything is saved, which is the failure worth catching early:
 * the garage has to grant our Azure AD app access inside their own BC, and until they do,
 * everything else looks correctly configured.
 */

interface Company {
  id: string;
  name?: string;
  displayName?: string;
}

interface ConnectionState {
  connected: boolean;
  tenantId?: string;
  environmentName?: string;
  companyId?: string;
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 ' +
  'focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

export default function BusinessCentralPanel() {
  const garageId = getGarageId();

  const [tenantId, setTenantId] = useState('');
  const [environmentName, setEnvironmentName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!garageId) return;
    api
      .get<ConnectionState>('/outbound/garagehive/settings', { params: { garageId } })
      .then(({ data }) => {
        setConnected(Boolean(data.connected));
        if (data.tenantId) setTenantId(data.tenantId);
        if (data.environmentName) setEnvironmentName(data.environmentName);
        if (data.companyId) setCompanyId(data.companyId);
      })
      .catch(() => {
        /* Not connected yet is the normal case here, not an error worth showing. */
      });
  }, [garageId]);

  const errText = (e: unknown, fallback: string) => {
    const res = (e as { response?: { data?: { error?: string } } })?.response;
    return res?.data?.error || fallback;
  };

  const loadCompanies = async () => {
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const { data } = await api.get<{ companies: Company[] }>(
        '/outbound/garagehive/companies',
        { params: { tenantId: tenantId.trim(), environmentName: environmentName.trim() } },
      );
      setCompanies(data.companies || []);
      if (!data.companies?.length) {
        setError('Business Central returned no companies for that environment.');
      } else {
        // Offer a sensible default rather than making them hunt: if only one company exists it is
        // certainly the right one, and otherwise keep whatever was already saved.
        if (data.companies.length === 1 && !companyId) setCompanyId(data.companies[0].id);
        setNotice(`Found ${data.companies.length} ${data.companies.length === 1 ? 'company' : 'companies'}.`);
      }
    } catch (e) {
      setCompanies([]);
      setError(errText(e, 'Could not reach Business Central.'));
    } finally {
      setLoading(false);
    }
  };

  const saveConnection = async () => {
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const { data } = await api.post<{ success: boolean; test?: { ok: boolean } }>(
        '/outbound/garagehive/connect',
        {
          garageId,
          tenantId: tenantId.trim(),
          environmentName: environmentName.trim(),
          companyId: companyId.trim(),
        },
      );
      setConnected(true);
      // Saving and working are different things. The row is written either way, so say which
      // happened rather than reporting success and leaving a dead connection behind.
      setNotice(
        data.test?.ok
          ? 'Connected — Business Central answered and the data is readable.'
          : 'Saved, but the test read failed. Check the permission set on the Garage Hive API in their environment.',
      );
    } catch (e) {
      setError(errText(e, 'Could not save the connection.'));
    } finally {
      setSaving(false);
    }
  };

  const canFetch = tenantId.trim() && environmentName.trim() && !loading;
  const canSave = canFetch && companyId.trim() && !saving;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Garage Hive API (Business Central)</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            connected
              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
              : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
          }`}
        >
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        Powers service and MOT reminders, caller recognition and advisory upsells. The garage grants
        our app access inside their own Business Central, then gives you their tenant ID and
        environment name. Branches of one group share an environment and differ only by company.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Tenant ID</span>
        <input
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Environment name</span>
        <input
          type="text"
          value={environmentName}
          onChange={(e) => setEnvironmentName(e.target.value)}
          placeholder="Production"
          className={inputClass}
        />
      </label>

      <button
        type="button"
        onClick={loadCompanies}
        disabled={!canFetch}
        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Checking…' : 'Fetch branches'}
      </button>

      {companies.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">
            Which branch is this garage?
          </span>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className={inputClass}
          >
            <option value="">Select a branch…</option>
            {companies.map((co) => (
              <option key={co.id} value={co.id}>
                {co.displayName || co.name || co.id}
              </option>
            ))}
          </select>
        </label>
      )}

      {companies.length === 0 && companyId && (
        <p className="text-xs text-slate-500">
          Currently pointing at company <code className="text-slate-700">{companyId}</code>. Fetch
          branches to change it.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={saveConnection}
          disabled={!canSave}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Connecting…' : connected ? 'Update connection' : 'Connect'}
        </button>
        {notice && <span className="text-xs text-emerald-700">{notice}</span>}
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
    </div>
  );
}

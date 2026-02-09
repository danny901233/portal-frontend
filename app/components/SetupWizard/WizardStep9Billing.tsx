'use client';

import { useState } from 'react';
import api from '../../lib/api';
import type { WizardData } from '../SetupWizard';

interface WizardStep9BillingProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  branchName: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep9Billing({
  data,
  updateData,
  branchName,
  onNext,
  onPrevious,
}: WizardStep9BillingProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (data.billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.billingEmail)) {
      setError('Please enter a valid billing email address');
      return;
    }

    setIsSaving(true);
    try {
      // Save billing info to backend
      await api.put('/api/customer/billing/business-info', {
        billingAddress: data.billingAddress || null,
        billingCity: data.billingCity || null,
        billingPostcode: data.billingPostcode || null,
        billingCountry: data.billingCountry || 'United Kingdom',
        vatNumber: data.vatNumber || null,
        companyRegNumber: data.companyRegNumber || null,
        billingEmail: data.billingEmail || null,
      });
      onNext();
    } catch (err) {
      console.error('Failed to save billing info:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Billing Information</h2>
        <p className="mt-2 text-slate-400">
          Your invoice details for ReceptionMate subscription.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Company Name (read-only, from branch name) */}
        <div>
          <label className="block text-sm font-medium text-slate-300">Company Name</label>
          <input
            type="text"
            value={branchName}
            disabled
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-slate-500"
          />
        </div>

        {/* Billing Address */}
        <div>
          <label htmlFor="billingAddress" className="block text-sm font-medium text-slate-300">
            Billing Address
          </label>
          <input
            type="text"
            id="billingAddress"
            value={data.billingAddress}
            onChange={(e) => updateData({ billingAddress: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="123 Main Street"
          />
        </div>

        {/* City */}
        <div>
          <label htmlFor="billingCity" className="block text-sm font-medium text-slate-300">
            City
          </label>
          <input
            type="text"
            id="billingCity"
            value={data.billingCity}
            onChange={(e) => updateData({ billingCity: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="London"
          />
        </div>

        {/* Postcode */}
        <div>
          <label htmlFor="billingPostcode" className="block text-sm font-medium text-slate-300">
            Postcode
          </label>
          <input
            type="text"
            id="billingPostcode"
            value={data.billingPostcode}
            onChange={(e) => updateData({ billingPostcode: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="SW1A 1AA"
          />
        </div>

        {/* Country */}
        <div>
          <label htmlFor="billingCountry" className="block text-sm font-medium text-slate-300">
            Country
          </label>
          <input
            type="text"
            id="billingCountry"
            value={data.billingCountry}
            onChange={(e) => updateData({ billingCountry: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="United Kingdom"
          />
        </div>

        {/* VAT Number */}
        <div>
          <label htmlFor="vatNumber" className="block text-sm font-medium text-slate-300">
            VAT Number (Optional)
          </label>
          <input
            type="text"
            id="vatNumber"
            value={data.vatNumber}
            onChange={(e) => updateData({ vatNumber: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="GB123456789"
          />
        </div>

        {/* Company Registration Number */}
        <div>
          <label htmlFor="companyRegNumber" className="block text-sm font-medium text-slate-300">
            Company Registration Number (Optional)
          </label>
          <input
            type="text"
            id="companyRegNumber"
            value={data.companyRegNumber}
            onChange={(e) => updateData({ companyRegNumber: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="12345678"
          />
        </div>

        {/* Billing Email */}
        <div>
          <label htmlFor="billingEmail" className="block text-sm font-medium text-slate-300">
            Billing Email
          </label>
          <input
            type="email"
            id="billingEmail"
            value={data.billingEmail}
            onChange={(e) => updateData({ billingEmail: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="accounts@yourgarage.co.uk"
          />
          <p className="mt-1 text-xs text-slate-500">
            Where should invoices be sent?
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-4">
          <button
            type="button"
            onClick={onPrevious}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-6 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Previous
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Next'}
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

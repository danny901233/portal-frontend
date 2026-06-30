'use client';

import { useState } from 'react';
import type { BusinessBillingInfo } from '../../lib/billing';
import { updateBusinessBillingInfo } from '../../lib/billing';

interface BillingInfoFormProps {
  businessInfo: BusinessBillingInfo;
  onUpdate: (updatedInfo: BusinessBillingInfo) => void;
  garageId?: string;
}

export default function BillingInfoForm({ businessInfo, onUpdate, garageId }: BillingInfoFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    billingAddress: businessInfo.billingAddress || '',
    billingCity: businessInfo.billingCity || '',
    billingPostcode: businessInfo.billingPostcode || '',
    billingCountry: businessInfo.billingCountry || 'United Kingdom',
    vatNumber: businessInfo.vatNumber || '',
    companyRegNumber: businessInfo.companyRegNumber || '',
    billingEmail: businessInfo.billingEmail || '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      const updated = await updateBusinessBillingInfo(formData, garageId);
      onUpdate(updated);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update billing info:', error);
      alert('Failed to update billing information. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setFormData({
      billingAddress: businessInfo.billingAddress || '',
      billingCity: businessInfo.billingCity || '',
      billingPostcode: businessInfo.billingPostcode || '',
      billingCountry: businessInfo.billingCountry || 'United Kingdom',
      vatNumber: businessInfo.vatNumber || '',
      companyRegNumber: businessInfo.companyRegNumber || '',
      billingEmail: businessInfo.billingEmail || '',
    });
    setIsEditing(false);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Billing Information</h2>
          <p className="mt-1 text-sm text-slate-500">
            This information appears on your invoices
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Edit
          </button>
        )}
      </div>

      {isEditing ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                Billing Address
              </label>
              <input
                type="text"
                value={formData.billingAddress}
                onChange={(e) => setFormData({ ...formData, billingAddress: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="123 Main Street"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                City
              </label>
              <input
                type="text"
                value={formData.billingCity}
                onChange={(e) => setFormData({ ...formData, billingCity: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="London"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                Postcode
              </label>
              <input
                type="text"
                value={formData.billingPostcode}
                onChange={(e) => setFormData({ ...formData, billingPostcode: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="SW1A 1AA"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                Country
              </label>
              <input
                type="text"
                value={formData.billingCountry}
                onChange={(e) => setFormData({ ...formData, billingCountry: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="United Kingdom"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                VAT Number
              </label>
              <input
                type="text"
                value={formData.vatNumber}
                onChange={(e) => setFormData({ ...formData, vatNumber: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="GB123456789"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-600">
                Company Registration Number
              </label>
              <input
                type="text"
                value={formData.companyRegNumber}
                onChange={(e) => setFormData({ ...formData, companyRegNumber: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="12345678"
              />
            </div>

            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-600">
                Billing Email
              </label>
              <input
                type="email"
                value={formData.billingEmail}
                onChange={(e) => setFormData({ ...formData, billingEmail: e.target.value })}
                className="w-full rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="billing@company.com"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSaving}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isSaving && (
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              )}
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Company Name</div>
              <div className="mt-1 text-sm text-slate-600">{businessInfo.name}</div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Address</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.billingAddress || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">City</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.billingCity || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Postcode</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.billingPostcode || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Country</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.billingCountry || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">VAT Number</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.vatNumber || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Company Registration
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.companyRegNumber || <span className="text-slate-600">Not set</span>}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Billing Email</div>
              <div className="mt-1 text-sm text-slate-600">
                {businessInfo.billingEmail || <span className="text-slate-600">Not set</span>}
              </div>
            </div>
          </div>

          {businessInfo.billingInfoUpdatedAt && (
            <div className="border-t border-slate-200 pt-4 text-xs text-slate-500">
              Last updated: {new Date(businessInfo.billingInfoUpdatedAt).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

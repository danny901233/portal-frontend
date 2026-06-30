'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getGarageId, getUserBranchRoles, isReceptionMateStaff } from '../lib/auth';
import { ALL_ASSIGNED_BRANCHES_IDENTIFIER } from '../lib/branchScope';
import type { GarageSummary } from '../types';
import { fetchGarages } from '../lib/api';
import {
  fetchCustomerInvoices,
  fetchBusinessBillingInfo,
  getMandateStatus,
  type Invoice,
  type BusinessBillingInfo,
  type MandateStatus,
} from '../lib/billing';
import InvoiceTable from './components/InvoiceTable';
import BillingInfoForm from './components/BillingInfoForm';
import MandateStatusCard from './components/MandateStatusCard';

export default function BillingPage() {
  const [selectedGarageId, setSelectedGarageId] = useState<string>(() => {
    const navGarage = getGarageId();
    if (!navGarage || navGarage === ALL_ASSIGNED_BRANCHES_IDENTIFIER) return 'all';
    return navGarage;
  });
  const [businessInfo, setBusinessInfo] = useState<BusinessBillingInfo | null>(null);

  const isStaffUser = useMemo(() => isReceptionMateStaff(), []);

  // Get managed garages (for non-staff manager users)
  const branchRoles = useMemo(() => getUserBranchRoles(), []);
  const managedGarageIds = useMemo(
    () =>
      Object.entries(branchRoles)
        .filter(([, role]) => role === 'MANAGER')
        .map(([garageId]) => garageId),
    [branchRoles]
  );

  // Fetch garages
  const garagesQuery = useQuery<{ garages: GarageSummary[] }>({
    queryKey: ['garages'],
    queryFn: fetchGarages,
  });

  // Staff see all garages; managers see only their assigned ones
  const managedGarages = useMemo(() => {
    if (!garagesQuery.data?.garages) return [];
    if (isStaffUser) return garagesQuery.data.garages;
    return garagesQuery.data.garages.filter((garage) =>
      managedGarageIds.includes(garage.id)
    );
  }, [garagesQuery.data, managedGarageIds, isStaffUser]);

  // Keep billing in sync with navbar garage selection (including live changes)
  useEffect(() => {
    const syncGarage = () => {
      const navGarage = getGarageId();
      if (!navGarage || navGarage === ALL_ASSIGNED_BRANCHES_IDENTIFIER) {
        setSelectedGarageId('all');
      } else {
        setSelectedGarageId(navGarage);
      }
    };
    syncGarage();
    window.addEventListener('storage', syncGarage);
    return () => window.removeEventListener('storage', syncGarage);
  }, []);

  // For manager users with one branch and nothing selected, default to it
  useEffect(() => {
    if (!isStaffUser && managedGarages.length === 1 && selectedGarageId === 'all') {
      setSelectedGarageId(managedGarages[0].id);
    }
  }, [managedGarages, isStaffUser, selectedGarageId]);

  // Fetch invoices
  const invoicesQuery = useQuery<Invoice[]>({
    queryKey: ['customer-invoices', selectedGarageId],
    queryFn: () =>
      fetchCustomerInvoices(selectedGarageId === 'all' ? undefined : selectedGarageId),
    enabled: isStaffUser ? selectedGarageId !== 'all' : (selectedGarageId !== 'all' || managedGarageIds.length > 0),
  });

  // Fetch business info
  const businessInfoQuery = useQuery<BusinessBillingInfo>({
    queryKey: ['business-billing-info', selectedGarageId],
    queryFn: () => fetchBusinessBillingInfo(selectedGarageId === 'all' ? undefined : selectedGarageId),
    enabled: selectedGarageId !== 'all',
  });

  // Fetch mandate status
  const mandateQuery = useQuery<MandateStatus>({
    queryKey: ['mandate-status', selectedGarageId],
    queryFn: () =>
      getMandateStatus(selectedGarageId === 'all' ? undefined : selectedGarageId),
    enabled: selectedGarageId !== 'all',
  });

  // Update local business info when query succeeds
  useEffect(() => {
    if (businessInfoQuery.data) {
      setBusinessInfo(businessInfoQuery.data);
    }
  }, [businessInfoQuery.data]);

  const handleBusinessInfoUpdate = (updated: BusinessBillingInfo) => {
    setBusinessInfo(updated);
  };

  const isLoading = invoicesQuery.isLoading || businessInfoQuery.isLoading || mandateQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="space-y-2 text-center">
          <div className="text-xl font-semibold text-slate-900">Loading billing information...</div>
          <div className="text-sm text-slate-500">Please wait</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Billing</h1>
        <p className="mt-1 text-slate-500">
          Manage your invoices, billing information, and payment method
        </p>
      </div>

      {/* Branch Selector — only shown when on All Branches in navbar */}
      {managedGarages.length > 1 && selectedGarageId === 'all' && (
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-slate-600">View invoices for:</label>
          <select
            value={selectedGarageId}
            onChange={(e) => setSelectedGarageId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">All Branches</option>
            {managedGarages.map((garage) => (
              <option key={garage.id} value={garage.id}>
                {garage.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Invoices Section */}
      <div>
        <h2 className="mb-4 text-xl font-semibold text-slate-900">Invoices</h2>
        <InvoiceTable invoices={invoicesQuery.data || []} />
      </div>

      {/* Billing Information */}
      {businessInfo && (
        <BillingInfoForm businessInfo={businessInfo} onUpdate={handleBusinessInfoUpdate} garageId={selectedGarageId === 'all' ? undefined : selectedGarageId} />
      )}

      {/* Direct Debit */}
      {mandateQuery.data && (
        <MandateStatusCard mandateStatus={mandateQuery.data} />
      )}
    </div>
  );
}

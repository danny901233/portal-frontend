'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { isReceptionMateStaff } from '../../lib/auth';
import api from '../../lib/api';

interface BillingForecastEntry {
  day: number;
  businesses: {
    businessName: string;
    branches: {
      branchId: string;
      branchName: string;
      subscriptionCost: number;
    }[];
    totalRevenue: number;
  }[];
  totalRevenue: number;
}

export default function BillingForecastPage() {
  const router = useRouter();
  const isStaff = isReceptionMateStaff();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);

  useEffect(() => {
    if (!isStaff) {
      router.replace('/calls');
    }
  }, [isStaff, router]);

  const { data: businessesData } = useQuery({
    queryKey: ['adminBusinesses'],
    queryFn: async () => {
      const { data } = await api.get('/admin/businesses');
      return data;
    },
    enabled: isStaff,
  });

  if (!isStaff) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
        Access denied - staff only
      </div>
    );
  }

  // Process billing data by day of month
  const billingByDay = new Map<number, BillingForecastEntry>();

  if (businessesData?.businesses) {
    businessesData.businesses.forEach((business: any) => {
      business.branches.forEach((branch: any) => {
        if (branch.billingDay && branch.subscriptionCostGbp > 0) {
          const day = branch.billingDay;

          if (!billingByDay.has(day)) {
            billingByDay.set(day, {
              day,
              businesses: [],
              totalRevenue: 0,
            });
          }

          const dayEntry = billingByDay.get(day)!;

          let businessEntry = dayEntry.businesses.find(b => b.businessName === business.name);
          if (!businessEntry) {
            businessEntry = {
              businessName: business.name,
              branches: [],
              totalRevenue: 0,
            };
            dayEntry.businesses.push(businessEntry);
          }

          businessEntry.branches.push({
            branchId: branch.id,
            branchName: branch.name,
            subscriptionCost: branch.subscriptionCostGbp,
          });
          businessEntry.totalRevenue += branch.subscriptionCostGbp;
          dayEntry.totalRevenue += branch.subscriptionCostGbp;
        }
      });
    });
  }

  // Get days in current month
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const emptyDays = Array.from({ length: firstDayOfMonth }, (_, i) => i);

  const monthName = currentMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const goToToday = () => {
    setCurrentMonth(new Date());
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
    }).format(amount);
  };

  const totalMonthlyRevenue = Array.from(billingByDay.values()).reduce(
    (sum, entry) => sum + entry.totalRevenue,
    0
  );

  const exportToCSV = () => {
    // Create CSV header
    const headers = ['Billing Day', 'Business Name', 'Branch Name', 'Branch ID', 'Monthly Subscription (£)'];

    // Create CSV rows
    const rows: string[][] = [];

    Array.from(billingByDay.entries())
      .sort(([a], [b]) => a - b)
      .forEach(([day, entry]) => {
        entry.businesses.forEach(business => {
          business.branches.forEach(branch => {
            rows.push([
              `${day}${day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'}`,
              business.businessName,
              branch.branchName,
              branch.branchId,
              branch.subscriptionCost.toFixed(2),
            ]);
          });
        });
      });

    // Add summary row
    rows.push([]);
    rows.push(['TOTAL MONTHLY REVENUE', '', '', '', totalMonthlyRevenue.toFixed(2)]);

    // Convert to CSV string
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
    ].join('\n');

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    const fileName = `billing-forecast-${monthName.toLowerCase().replace(' ', '-')}.csv`;
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <button
              onClick={() => router.push('/admin')}
              className="text-sm text-slate-500 hover:text-slate-600 mb-2"
            >
              ← Back to Admin
            </button>
            <h1 className="text-2xl font-semibold text-slate-900">Billing Forecast</h1>
            <p className="text-sm text-slate-500">Monthly revenue calendar</p>
          </div>
          <div className="text-right">
            <button
              onClick={exportToCSV}
              className="mb-3 px-4 py-2 bg-emerald-50 hover:bg-emerald-50 text-emerald-700 rounded-lg text-sm font-semibold transition-colors border border-emerald-300"
            >
              📊 Export CSV
            </button>
            <p className="text-sm text-slate-500">Expected Monthly Revenue</p>
            <p className="text-2xl font-bold text-emerald-700">{formatCurrency(totalMonthlyRevenue)}</p>
          </div>
        </header>

        {/* Calendar Navigation */}
        <div className="mb-6 flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4">
          <button
            onClick={goToPreviousMonth}
            className="rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-700"
          >
            ← Previous
          </button>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">{monthName}</h2>
            <button
              onClick={goToToday}
              className="rounded-lg border border-brand-200 bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-100"
            >
              Today
            </button>
          </div>
          <button
            onClick={goToNextMonth}
            className="rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-700"
          >
            Next →
          </button>
        </div>

        {/* Calendar Grid */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-2 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div key={day} className="text-center text-xs font-semibold text-slate-500 py-2">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar days */}
          <div className="grid grid-cols-7 gap-2">
            {/* Empty cells for days before month starts */}
            {emptyDays.map((i) => (
              <div key={`empty-${i}`} className="aspect-square" />
            ))}

            {/* Days of the month */}
            {days.map((day) => {
              const billingEntry = billingByDay.get(day);
              const hasBilling = !!billingEntry;
              const isToday =
                day === new Date().getDate() &&
                month === new Date().getMonth() &&
                year === new Date().getFullYear();

              return (
                <div
                  key={day}
                  className="relative aspect-square"
                  onMouseEnter={() => setHoveredDay(day)}
                  onMouseLeave={() => setHoveredDay(null)}
                >
                  <div
                    className={`
                      h-full rounded-lg border p-2 transition-all
                      ${isToday ? 'border-brand-600/50 bg-brand-100' : 'border-slate-300/50 bg-slate-50'}
                      ${hasBilling ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-50' : 'hover:bg-slate-100'}
                    `}
                  >
                    <div className="flex flex-col h-full">
                      <span className={`text-sm font-semibold ${isToday ? 'text-brand-600' : 'text-slate-600'}`}>
                        {day}
                      </span>
                      {hasBilling && (
                        <div className="mt-auto">
                          <span className="text-[10px] font-semibold text-emerald-700">
                            {formatCurrency(billingEntry.totalRevenue)}
                          </span>
                          <div className="text-[9px] text-slate-500 mt-0.5">
                            {billingEntry.businesses.length} customer{billingEntry.businesses.length !== 1 ? 's' : ''}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Hover tooltip */}
                  {hoveredDay === day && hasBilling && (
                    <div className="absolute z-50 left-0 top-full mt-2 w-72 rounded-lg border border-slate-300 bg-white p-3 shadow-xl">
                      <div className="mb-2 flex items-center justify-between border-b border-slate-300 pb-2">
                        <span className="text-sm font-semibold text-slate-700">
                          {day}{day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'} of the month
                        </span>
                        <span className="text-sm font-bold text-emerald-700">
                          {formatCurrency(billingEntry.totalRevenue)}
                        </span>
                      </div>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {billingEntry.businesses.map((business, idx) => (
                          <div key={idx} className="text-xs">
                            <p className="font-semibold text-slate-600 mb-1">{business.businessName}</p>
                            <div className="pl-3 space-y-1">
                              {business.branches.map((branch, branchIdx) => (
                                <div key={branchIdx} className="flex items-center justify-between text-slate-500">
                                  <span>{branch.branchName}</span>
                                  <span className="text-emerald-700">{formatCurrency(branch.subscriptionCost)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Summary by billing day */}
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Billing Schedule Summary</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from(billingByDay.entries())
              .sort(([a], [b]) => a - b)
              .map(([day, entry]) => (
                <div
                  key={day}
                  className="rounded-lg border border-slate-300/50 bg-slate-50 p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-slate-700">
                      {day}{day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'}
                    </span>
                    <span className="text-sm font-bold text-emerald-700">
                      {formatCurrency(entry.totalRevenue)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {entry.businesses.length} customer{entry.businesses.length !== 1 ? 's' : ''}
                  </p>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

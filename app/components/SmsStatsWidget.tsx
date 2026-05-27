'use client';

import { useEffect, useState } from 'react';
import { getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

interface SmsStats {
  totalSent: number;
  totalCost: number;
  costPerSms: number;
}

interface SmsStatsWidgetProps {
  garageId: string;
  startDate?: string;
  endDate?: string;
}

export default function SmsStatsWidget({ garageId, startDate, endDate }: SmsStatsWidgetProps) {
  const [stats, setStats] = useState<SmsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const token = getSessionToken();
        const params = new URLSearchParams();
        if (startDate) params.append('startDate', startDate);
        if (endDate) params.append('endDate', endDate);

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/sms-stats?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setStats(data.stats);
        }
      } catch (err) {
        console.error('Error fetching SMS stats:', err);
        setError('Failed to load SMS stats');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [garageId, startDate, endDate]);

  const handleDownloadCSV = async () => {
    setDownloading(true);
    try {
      const token = getSessionToken();
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/sms-stats/csv?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sms-billing-${startDate || 'all'}-to-${endDate || 'all'}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Error downloading CSV:', error);
      alert('Failed to download CSV');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4">
        <div className="animate-pulse">
          <div className="h-3 bg-slate-800 rounded w-24 mb-3"></div>
          <div className="space-y-2">
            <div className="h-2 bg-slate-800 rounded"></div>
            <div className="h-2 bg-slate-800 rounded w-4/5"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      minimumFractionDigits: 2,
    }).format(value);
  };

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-100">SMS Booking Links</h3>
        <button
          onClick={handleDownloadCSV}
          disabled={downloading}
          className={cn(
            'text-xs px-3 py-1 rounded-lg border border-emerald-500/60 bg-emerald-500/10 text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100',
            downloading && 'cursor-not-allowed opacity-60'
          )}
        >
          {downloading ? 'Downloading…' : 'Download CSV'}
        </button>
      </div>

      <div className="space-y-3">
        {/* Total SMS Sent */}
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-xs text-slate-400 mb-1">SMS Sent</p>
          <p className="text-2xl font-bold text-slate-100">{stats.totalSent}</p>
        </div>

        <div className="text-xs text-slate-500 bg-slate-800/40 rounded p-2">
          <strong>Billing Note:</strong> SMS messages are charged at £0.99 each for customers requesting online booking links.
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import { useLang } from '@/app/i18n/LocaleProvider';

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
  const lang = useLang();
  const c = {
    en: {
      csvFailed: 'Failed to download CSV',
      title: 'SMS Booking Links',
      downloading: 'Downloading…',
      downloadCsv: 'Download CSV',
      smsSent: 'SMS Sent',
      billingNote: 'Billing Note:',
      billingDetail: (price: string) =>
        `SMS messages are charged at £${price} each for customers requesting online booking links.`,
    },
    fr: {
      csvFailed: 'Échec du téléchargement du CSV',
      title: 'Liens de réservation SMS',
      downloading: 'Téléchargement…',
      downloadCsv: 'Télécharger le CSV',
      smsSent: 'SMS envoyés',
      billingNote: 'Note de facturation :',
      billingDetail: (price: string) =>
        `Les messages SMS sont facturés £${price} chacun pour les clients demandant des liens de réservation en ligne.`,
    },
  }[lang];
  const [stats, setStats] = useState<SmsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

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
      } catch (error) {
        console.error('Error fetching SMS stats:', error);
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
      alert(c.csvFailed);
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white/40 border border-slate-200 rounded-lg p-4">
        <div className="animate-pulse">
          <div className="h-3 bg-slate-200 rounded w-24 mb-3"></div>
          <div className="space-y-2">
            <div className="h-2 bg-slate-200 rounded"></div>
            <div className="h-2 bg-slate-200 rounded w-4/5"></div>
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
    <div className="bg-white/40 border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">{c.title}</h3>
        <button
          onClick={handleDownloadCSV}
          disabled={downloading}
          className={cn(
            'text-xs px-3 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 transition hover:border-emerald-400 hover:text-emerald-100',
            downloading && 'cursor-not-allowed opacity-60'
          )}
        >
          {downloading ? c.downloading : c.downloadCsv}
        </button>
      </div>

      <div className="space-y-3">
        {/* Total SMS Sent */}
        <div className="bg-slate-50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">{c.smsSent}</p>
          <p className="text-2xl font-bold text-slate-900">{stats.totalSent}</p>
        </div>

        <div className="text-xs text-slate-500 bg-slate-50 rounded p-2">
          <strong>{c.billingNote}</strong> {c.billingDetail((stats.costPerSms ?? 0.99).toFixed(2))}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

interface PlatformStats {
  active: number;
  needsAttention: number;
  resolved: number;
  total: number;
}

interface MessageStats {
  whatsapp: PlatformStats;
  facebook: PlatformStats;
  instagram: PlatformStats;
  totals: PlatformStats;
}

interface MessageStatsWidgetProps {
  garageId: string;
  startDate?: string;
  endDate?: string;
}

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
  </svg>
);

const FacebookIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
  </svg>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
  </svg>
);

export default function MessageStatsWidget({ garageId, startDate, endDate }: MessageStatsWidgetProps) {
  const [stats, setStats] = useState<MessageStats | null>(null);
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
          `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/message-stats?${params}`,
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
        console.error('Error fetching message stats:', error);
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
        `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/message-stats/csv?${params}`,
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
        a.download = `message-stats-${startDate || 'all'}-to-${endDate || 'all'}.csv`;
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

  const platforms = [
    { id: 'whatsapp', name: 'WhatsApp', icon: WhatsAppIcon, color: 'text-green-400' },
    { id: 'facebook', name: 'Facebook', icon: FacebookIcon, color: 'text-blue-400' },
    { id: 'instagram', name: 'Instagram', icon: InstagramIcon, color: 'text-purple-400' },
  ];

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-100">Message Statistics</h3>
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

      {/* Overall Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-slate-800/40 rounded-lg p-2">
          <p className="text-[10px] text-slate-400 mb-0.5">Active</p>
          <p className="text-lg font-bold text-slate-100">{stats.totals.active}</p>
        </div>
        <div className="bg-orange-500/10 rounded-lg p-2">
          <p className="text-[10px] text-orange-400 mb-0.5">Attention</p>
          <p className="text-lg font-bold text-orange-400">{stats.totals.needsAttention}</p>
        </div>
        <div className="bg-green-500/10 rounded-lg p-2">
          <p className="text-[10px] text-green-400 mb-0.5">Resolved</p>
          <p className="text-lg font-bold text-green-400">{stats.totals.resolved}</p>
        </div>
      </div>

      {/* Platform Breakdown */}
      <div className="space-y-2">
        {platforms.map((platform) => {
          const platformStats = stats[platform.id as keyof typeof stats] as PlatformStats;
          const Icon = platform.icon;

          return (
            <div key={platform.id} className="flex items-center justify-between p-2 bg-slate-800/40 rounded text-xs">
              <div className="flex items-center gap-2">
                <div className={cn(platform.color)}>
                  <Icon />
                </div>
                <span className="text-slate-100 font-medium">{platform.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-slate-400">{platformStats.active}</span>
                {platformStats.needsAttention > 0 && (
                  <span className="text-orange-400">{platformStats.needsAttention}</span>
                )}
                <span className="text-slate-300 font-semibold">{platformStats.total}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

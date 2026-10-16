'use client';

import { useEffect, useState } from 'react';

// LP Autos: one shared website, two branches, each its own Garage/widget. This page is the
// embed target instead of /widget/{garageId} directly — it asks which branch, then hands off
// to that branch's existing widget by navigating this same iframe to /widget/{garageId}.
// Deliberately hard-coded to these two garages rather than a generic "branch group" system:
// LP Autos is the only customer that needs this today (see GH issue #414).
const BRANCHES = [
  {
    garageId: '8d2ee5e6-56c9-4a9c-ad49-38bfecae6906',
    name: 'LP Autos MOT',
    address: null as string | null,
  },
  {
    garageId: '73781b1a-8a6e-47e3-bde1-7c7c4b0223d3',
    name: 'L P Autos Ltd',
    address: 'Unit 5 Greenhalgh St, Failsworth, Manchester M35 0BW',
  },
];

const PRIMARY_COLOR = '#1e3a8a';

if (typeof window !== 'undefined') {
  const link = document.createElement('link');
  link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap';
  link.rel = 'stylesheet';
  document.head.appendChild(link);
}

export default function LpAutosBranchPicker() {
  const [open, setOpen] = useState(false);

  // Same resize protocol the real widget uses, so the embedding page's iframe box resizes
  // to match — the floating bubble stays small, the picker card needs room to show both branches.
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage(
      open
        ? { type: 'rm-resize', width: '340px', height: '420px' }
        : { type: 'rm-resize', width: '150px', height: '150px' },
      '*',
    );
  }, [open]);

  const goToBranch = (garageId: string) => {
    window.location.href = `/widget/${garageId}`;
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center justify-center transition-transform duration-300 hover:scale-105 active:scale-95"
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          background: PRIMARY_COLOR,
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 5px 18px 0 rgba(151, 124, 156, 0.2), 0 5px 32px 0 rgba(203, 195, 212, 0.2), 0 8px 58px 0 rgba(216, 212, 221, 0.1)',
        }}
        aria-label="Open chat"
      >
        <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col overflow-hidden"
      style={{
        width: '340px',
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: '20px',
        background: 'white',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        fontFamily: "'Poppins', sans-serif",
      }}
    >
      <div
        className="flex items-start justify-between"
        style={{ background: PRIMARY_COLOR, padding: '20px 20px 16px' }}
      >
        <div>
          <div style={{ color: 'white', fontWeight: 700, fontSize: '16px', lineHeight: 1.3 }}>
            Which branch would you like?
          </div>
          <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '12.5px', marginTop: '4px' }}>
            We&rsquo;ll take you straight to them.
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'white', opacity: 0.8, flexShrink: 0 }}
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {BRANCHES.map((branch) => (
          <button
            key={branch.garageId}
            onClick={() => goToBranch(branch.garageId)}
            className="transition-colors"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '100%',
              padding: '12px 14px',
              borderRadius: '12px',
              border: '1px solid rgba(0,0,0,0.10)',
              background: 'rgba(0,0,0,0.02)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.02)'; }}
          >
            <span style={{ fontWeight: 600, fontSize: '14px', color: '#111827' }}>{branch.name}</span>
            {branch.address && (
              <span style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>{branch.address}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ textAlign: 'center', paddingBottom: '12px' }}>
        <span style={{ fontSize: '11px', color: '#9ca3af' }}>Powered by ReceptionMate</span>
      </div>
    </div>
  );
}

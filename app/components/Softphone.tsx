'use client';

// Browser softphone — a phone icon in the top bar opens a dialer. Calls are
// placed in-browser over WebRTC (Twilio Voice SDK), presenting the garage's
// verified caller ID. No mobile bridge — you talk through the browser.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGarageId } from '../lib/auth';
import { fetchVoiceToken, getOutboundCallerId } from '../lib/api';

type Status = 'idle' | 'setup' | 'connecting' | 'in-call' | 'error';

// Twilio SDK types are loaded dynamically; keep these loose.
/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Softphone({ variant = 'icon' }: { variant?: 'icon' | 'bar' }) {
  const [open, setOpen] = useState(false);
  const [garageId, setGarageId] = useState<string | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const deviceRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const gid = getGarageId();
    setGarageId(gid);
    if (gid) getOutboundCallerId(gid).then((r) => { setVerified(r.verified); setCallerId(r.number); }).catch(() => {});
  }, [open]);

  // Close popover on outside click (unless mid-call)
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (status === 'in-call' || status === 'connecting') return;
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, status]);

  const ensureDevice = useCallback(async () => {
    if (deviceRef.current) return deviceRef.current;
    if (!garageId) throw new Error('Select a branch first');
    const { token } = await fetchVoiceToken(garageId);
    const mod = await import('@twilio/voice-sdk');
    const Device = mod.Device;
    const device = new Device(token, { codecPreferences: ['opus', 'pcmu'] as any, logLevel: 'error' as any });
    device.on('tokenWillExpire', async () => {
      try { const t = await fetchVoiceToken(garageId); device.updateToken(t.token); } catch { /* ignore */ }
    });
    device.on('error', (e: any) => { setErrMsg(e?.message || 'Call error'); setStatus('error'); });
    deviceRef.current = device;
    return device;
  }, [garageId]);

  const startCall = useCallback(async () => {
    setErrMsg(null);
    if (!garageId || !verified || !callerId || !number.trim()) return;
    try {
      setStatus('setup');
      const device = await ensureDevice();
      setStatus('connecting');
      const call = await device.connect({ params: { To: number.trim(), callerId, garageId } });
      callRef.current = call;
      call.on('accept', () => setStatus('in-call'));
      call.on('disconnect', () => { setStatus('idle'); setMuted(false); callRef.current = null; });
      call.on('cancel', () => { setStatus('idle'); callRef.current = null; });
      call.on('reject', () => { setStatus('idle'); callRef.current = null; });
      call.on('error', (e: any) => { setErrMsg(e?.message || 'Call failed'); setStatus('error'); });
    } catch (e: any) {
      setErrMsg(e?.message || 'Could not start the call'); setStatus('error');
    }
  }, [garageId, verified, callerId, number, ensureDevice]);

  const hangup = useCallback(() => { try { callRef.current?.disconnect(); } catch { /* */ } setStatus('idle'); }, []);
  const toggleMute = useCallback(() => { const m = !muted; try { callRef.current?.mute(m); } catch { /* */ } setMuted(m); }, [muted]);
  // Native audio-route bridge (iOS app only) — switch loudspeaker / earpiece.
  const audioBridge = () => (typeof window !== 'undefined' ? (window as unknown as { webkit?: { messageHandlers?: { audioRoute?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.audioRoute : null);
  const setSpeaker = useCallback((on: boolean) => { try { audioBridge()?.postMessage({ speaker: on }); } catch { /* */ } setSpeakerOn(on); }, []);

  const busy = status === 'connecting' || status === 'in-call' || status === 'setup';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

  const phoneIcon = <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 013 4c0-.6.5-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z" /></svg>;

  return (
    <div className={`relative ${variant === 'bar' ? 'w-full' : ''}`} ref={popRef}>
      {variant === 'bar' ? (
        <button
          type="button"
          aria-label="Open dialer"
          onClick={() => setOpen((o) => !o)}
          className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition ${busy ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500 hover:bg-emerald-600'}`}
        >
          {phoneIcon}
          {busy ? 'On a call…' : 'Make a call'}
        </button>
      ) : (
        <button
          type="button"
          aria-label="Open dialer"
          onClick={() => setOpen((o) => !o)}
          className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-white transition ${busy ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500 hover:bg-emerald-600'}`}
        >
          {phoneIcon}
        </button>
      )}

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Calling from</p>
            <p className="text-sm font-semibold text-slate-900">{verified && callerId ? callerId : 'Not set up'}</p>
          </div>

          {!verified ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              Verify your caller ID first, in <a href="/outbound-calls" className="font-medium text-brand-600 hover:underline">Calls → Outbound</a>.
            </div>
          ) : (
            <div className="px-4 py-3">
              <input
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="Enter a number"
                inputMode="tel"
                className="mb-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-center text-lg font-semibold tracking-wide text-slate-900 placeholder:text-sm placeholder:font-normal focus:border-brand-500 focus:outline-none"
              />
              <div className="grid grid-cols-3 gap-2">
                {keys.map((k) => (
                  <button key={k} type="button" onClick={() => setNumber((n) => n + k)} className="rounded-full bg-slate-100 py-2.5 text-lg font-semibold text-slate-800 hover:bg-slate-200">{k}</button>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-center gap-3">
                {status === 'in-call' || status === 'connecting' ? (
                  <>
                    <button type="button" onClick={toggleMute} className={`inline-flex h-11 w-11 items-center justify-center rounded-full ${muted ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} aria-label="Mute">
                      <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-2.1A7 7 0 0019 12h-2z" /></svg>
                    </button>
                    <button type="button" onClick={hangup} className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-500 text-white hover:bg-rose-600" aria-label="Hang up">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M21 15.5c-1.2 0-2.4-.2-3.6-.6a1 1 0 00-1 .2l-2.2 2.2a15 15 0 01-6.6-6.6l2.2-2.2a1 1 0 00.2-1C9.2 6.4 9 5.2 9 4a1 1 0 00-1-1H4.5C3.7 3 3 3.7 3 4.5 3 14.2 9.8 21 19.5 21c.8 0 1.5-.7 1.5-1.5V16a1 1 0 00-1-1z" transform="rotate(135 12 12)" /></svg>
                    </button>
                    {audioBridge() ? (
                      <button type="button" onClick={() => setSpeaker(!speakerOn)} className={`inline-flex h-11 w-11 items-center justify-center rounded-full ${speakerOn ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} aria-label={speakerOn ? 'Speaker on' : 'Speaker off'} title={speakerOn ? 'Loudspeaker' : 'Earpiece'}>
                        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm11-4.8v2.1a7 7 0 010 13.4v2.1a9 9 0 000-17.6zm2.5 6.8a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" /></svg>
                      </button>
                    ) : <span className="w-11" />}
                  </>
                ) : (
                  <>
                    <span className="w-11" />
                    <button type="button" onClick={startCall} disabled={busy || !number.trim()} className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40" aria-label="Call">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 013 4c0-.6.5-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z" /></svg>
                    </button>
                    <button type="button" onClick={() => setNumber((n) => n.slice(0, -1))} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100" aria-label="Delete">⌫</button>
                  </>
                )}
              </div>

              <p className="mt-2 h-4 text-center text-xs text-slate-500">
                {status === 'setup' && 'Preparing…'}
                {status === 'connecting' && 'Connecting…'}
                {status === 'in-call' && 'Connected'}
                {errMsg && <span className="text-rose-600">{errMsg}</span>}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

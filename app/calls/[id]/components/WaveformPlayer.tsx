'use client';

// Compact waveform-based audio player for /calls/[id].
// Uses WaveSurfer.js loaded from unpkg at runtime — no bundle change,
// no package.json touch. Falls back to a plain <audio> element if the
// library fails to load or the browser can't decode the audio (e.g. a
// codec Safari doesn't like). Trial-friendly: revert = remove import.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

declare global {
  interface Window {
    // WaveSurfer.js attaches itself to window when loaded via <script>
    WaveSurfer?: {
      create: (opts: Record<string, unknown>) => WaveSurferInstance;
    };
  }
}

// Imperative handle exposed to parents via ref — lets the transcript
// click-to-seek call into the waveform without a re-render round-trip.
export interface WaveformPlayerHandle {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
}

interface WaveSurferInstance {
  on: (event: string, handler: (arg?: unknown) => void) => void;
  play: () => void;
  pause: () => void;
  isPlaying: () => boolean;
  getCurrentTime: () => number;
  getDuration: () => number;
  setTime: (seconds: number) => void;
  destroy: () => void;
}

// Self-hosted so it loads from same-origin. Portal CSP blocks external scripts.
// File lives at public/wavesurfer.js (from https://unpkg.com/wavesurfer.js@7).
const WAVESURFER_SRC = '/wavesurfer.js';

function fmt(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Load the WaveSurfer CDN script once, cached across mounts
let loaderPromise: Promise<void> | null = null;
function loadWaveSurfer(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.WaveSurfer) return Promise.resolve();
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WAVESURFER_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('wavesurfer load failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = WAVESURFER_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loaderPromise = null;
      reject(new Error('wavesurfer load failed'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

interface Props {
  src: string;
  downloadUrl: string;
  downloadLabel: string;
  downloadFilename: string;
}

export const WaveformPlayer = forwardRef<WaveformPlayerHandle, Props>(function WaveformPlayer(
  { src, downloadUrl, downloadLabel, downloadFilename },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurferInstance | null>(null);
  const audioFallbackRef = useRef<HTMLAudioElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timeLabel, setTimeLabel] = useState('0:00 / —');

  // Imperative handle — parents can call waveformRef.current.seek(seconds)
  // to jump to a specific moment (used by transcript click-to-seek).
  // Falls through to the plain <audio> fallback if the waveform failed to load.
  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => {
      const s = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
      if (wsRef.current) {
        try { wsRef.current.setTime(s); wsRef.current.play(); } catch { /* ignore */ }
        return;
      }
      const audio = audioFallbackRef.current;
      if (audio) {
        try { audio.currentTime = s; void audio.play().catch(() => { /* ignore */ }); } catch { /* ignore */ }
      }
    },
    play: () => {
      if (wsRef.current) { try { wsRef.current.play(); } catch { /* ignore */ } return; }
      const audio = audioFallbackRef.current;
      if (audio) void audio.play().catch(() => { /* ignore */ });
    },
    pause: () => {
      if (wsRef.current) { try { wsRef.current.pause(); } catch { /* ignore */ } return; }
      const audio = audioFallbackRef.current;
      if (audio) audio.pause();
    },
  }), []);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        await loadWaveSurfer();
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }
      if (cancelled || !window.WaveSurfer || !containerRef.current) return;

      const instance = window.WaveSurfer.create({
        container: containerRef.current,
        waveColor: '#a5b4fc',
        progressColor: '#4f46e5',
        cursorColor: '#4338ca',
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        height: 28,
        normalize: true,
        url: src,
      });
      wsRef.current = instance;

      instance.on('ready', () => {
        if (cancelled) return;
        setReady(true);
        setTimeLabel(`0:00 / ${fmt(instance.getDuration())}`);
      });
      instance.on('audioprocess', () => {
        if (cancelled) return;
        setTimeLabel(`${fmt(instance.getCurrentTime())} / ${fmt(instance.getDuration())}`);
      });
      instance.on('seeking', () => {
        if (cancelled) return;
        setTimeLabel(`${fmt(instance.getCurrentTime())} / ${fmt(instance.getDuration())}`);
      });
      instance.on('play', () => { if (!cancelled) setIsPlaying(true); });
      instance.on('pause', () => { if (!cancelled) setIsPlaying(false); });
      instance.on('finish', () => { if (!cancelled) setIsPlaying(false); });
      instance.on('error', () => { if (!cancelled) setFailed(true); });
    };

    setup();

    return () => {
      cancelled = true;
      try {
        wsRef.current?.destroy();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [src]);

  // Fallback: CDN load failed OR audio decode failed → plain <audio>.
  // Attach a ref so the imperative seek() handle can still drive the fallback.
  if (failed) {
    return (
      <div className="space-y-3">
        <audio ref={audioFallbackRef} src={src} controls className="w-full" />
        <a
          href={downloadUrl}
          download={downloadFilename}
          className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-xs text-brand-600 hover:border-slate-500 hover:text-brand-700"
        >
          {downloadLabel}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-full bg-slate-100 px-2 py-1">
        <button
          type="button"
          onClick={() => {
            const ws = wsRef.current;
            if (!ws) return;
            if (ws.isPlaying()) ws.pause();
            else ws.play();
          }}
          disabled={!ready}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs text-white hover:bg-brand-700 disabled:opacity-40"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <div ref={containerRef} className="min-w-0 flex-1" />
        <span className="flex-shrink-0 text-[11px] tabular-nums text-slate-500">{timeLabel}</span>
      </div>
      <a
        href={downloadUrl}
        download={downloadFilename}
        className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-xs text-brand-600 hover:border-slate-500 hover:text-brand-700"
      >
        {downloadLabel}
      </a>
    </div>
  );
});

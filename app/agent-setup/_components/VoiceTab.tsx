'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { generateVoicePreview } from '../../lib/api';
import { getGarageId } from '../../lib/auth';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type VoiceOption =
  | 'tom'
  | 'leah'
  | 'sophie'
  | 'gemma'
  | 'isobel'
  | 'fraser'
  | 'amelia';

interface VoiceCardDef {
  value: VoiceOption;
  label: string;
  description: string;
}

const VOICE_OPTIONS: VoiceCardDef[] = [
  { value: 'tom', label: 'Tom', description: 'Friendly mid-thirties male voice' },
  { value: 'leah', label: 'Leah', description: 'Pleasantly clear British female voice' },
  { value: 'sophie', label: 'Sophie', description: 'Clear and conversational female voice' },
  { value: 'gemma', label: 'Gemma', description: 'Modern Northern English friendly female voice' },
  { value: 'isobel', label: 'Isobel', description: 'Scottish female voice, youthful and warm' },
  { value: 'fraser', label: 'Fraser', description: 'Soft male Scottish Glaswegian voice' },
  { value: 'amelia', label: 'Amelia', description: 'Standard British female voice' },
];

const TONE_OPTIONS: { value: 'standard' | 'upbeat' | 'professional'; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: 'Balanced, warm — feels like a real person' },
  { value: 'upbeat', label: 'Upbeat', description: 'Energetic and enthusiastic — smiles through the phone' },
  { value: 'professional', label: 'Professional', description: 'Polished, formal British receptionist register' },
];

export default function VoiceTab({ config, save, isSaving }: Props) {
  const [voice, setVoice] = useState<VoiceOption>(
    (config.voice as VoiceOption) ?? 'leah'
  );
  const [tonePreference, setTonePreference] = useState<'standard' | 'upbeat' | 'professional'>(
    (config.tonePreference as 'standard' | 'upbeat' | 'professional') ?? 'standard'
  );
  const [interruptionSensitivity, setInterruptionSensitivity] = useState<number>(
    typeof config.interruptionSensitivity === 'number' ? config.interruptionSensitivity : 0.5
  );

  // Cache of last-fetched preview audio per voice — lets the user replay
  // without re-hitting the backend (each generation costs an ElevenLabs call).
  const audioCache = useRef<Map<VoiceOption, string>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadingVoice, setLoadingVoice] = useState<VoiceOption | null>(null);
  const [playingVoice, setPlayingVoice] = useState<VoiceOption | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setVoice((config.voice as VoiceOption) ?? 'leah');
    setTonePreference(
      (config.tonePreference as 'standard' | 'upbeat' | 'professional') ?? 'standard'
    );
    setInterruptionSensitivity(
      typeof config.interruptionSensitivity === 'number' ? config.interruptionSensitivity : 0.5
    );
  }, [config.voice, config.tonePreference, config.interruptionSensitivity]);

  // Stop any playing audio when the component unmounts so a stale clip doesn't
  // keep playing after the user navigates away.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      for (const url of audioCache.current.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const handlePreview = async (target: VoiceOption) => {
    setPreviewError(null);

    // Stop whatever is currently playing
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    let url = audioCache.current.get(target);
    if (!url) {
      try {
        setLoadingVoice(target);
        const garageId = getGarageId() ?? undefined;
        const blob = await generateVoicePreview(target, garageId);
        url = URL.createObjectURL(blob);
        audioCache.current.set(target, url);
      } catch (err) {
        console.error('Voice preview failed:', err);
        setPreviewError('Couldn\'t play preview — try again in a moment.');
        setLoadingVoice(null);
        return;
      } finally {
        setLoadingVoice(null);
      }
    }

    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setPlayingVoice((cur) => (cur === target ? null : cur));
    audio.onerror = () => {
      setPlayingVoice(null);
      setPreviewError('Couldn\'t play preview.');
    };
    setPlayingVoice(target);
    await audio.play().catch(() => {
      setPlayingVoice(null);
      setPreviewError('Couldn\'t play preview.');
    });
  };

  const handleSave = () => {
    // Response speed is no longer a portal setting — every agent uses fixed dynamic
    // endpointing (0.5s floor, max 6.0s). We keep the stored field pinned to 'normal'
    // so the agent config carries a valid, consistent value.
    void save({ voice, tonePreference, responseSpeed: 'normal', interruptionSensitivity });
  };

  return (
    <TabShell
      title="Identity & voice"
      description="Pick the voice and tone the agent uses on every call. Tap Play to hear a sample. Changes apply to the next call."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">Tone</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {TONE_OPTIONS.map((opt) => {
            const isActive = tonePreference === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTonePreference(opt.value)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-100'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">Voice</label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {VOICE_OPTIONS.map((opt) => {
            const isActive = voice === opt.value;
            const isLoading = loadingVoice === opt.value;
            const isPlaying = playingVoice === opt.value;
            return (
              <div
                key={opt.value}
                onClick={() => setVoice(opt.value)}
                className={`relative cursor-pointer rounded-xl border p-4 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-100 shadow-lg shadow-brand-600/20'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-900">{opt.label}</h3>
                  <div className="flex items-center gap-1.5">
                    {isActive && (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-medium text-white">
                        Selected
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handlePreview(opt.value);
                      }}
                      disabled={isLoading}
                      aria-label={isPlaying ? `Stop ${opt.label} preview` : `Play ${opt.label} preview`}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-full border transition ${
                        isPlaying
                          ? 'border-brand-600 bg-brand-600 text-white'
                          : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600 hover:text-brand-600'
                      } disabled:cursor-wait disabled:opacity-60`}
                    >
                      {isLoading ? <Spinner /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-500">{opt.description}</p>
              </div>
            );
          })}
        </div>
        {previewError ? (
          <p className="mt-2 text-xs text-rose-600">{previewError}</p>
        ) : null}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Interruption sensitivity
        </label>
        <p className="mb-3 text-xs text-slate-500">
          How easily a caller can interrupt the agent. Lower = the agent finishes speaking
          before listening; higher = it stops the moment you start talking.
        </p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-500">Hard to interrupt</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={interruptionSensitivity}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) {
                  setInterruptionSensitivity(Math.min(1, Math.max(0, v)));
                }
              }}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={interruptionSensitivity}
              className="flex-1 accent-brand-600"
            />
            <span className="text-xs font-medium text-slate-500">Easy to interrupt</span>
          </div>
          <div className="mt-2 text-center text-sm font-medium text-slate-900">
            {interruptionSensitivity.toFixed(1)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
        <p className="text-slate-600">
          <strong className="text-slate-900">Current voice:</strong>{' '}
          {VOICE_OPTIONS.find((o) => o.value === voice)?.label ?? voice}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Advanced voice tuning (stability, similarity boost, style) is set
          globally for now — same for all garages. Contact RM staff if you need
          per-garage fine-tuning.
        </p>
      </div>
    </TabShell>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

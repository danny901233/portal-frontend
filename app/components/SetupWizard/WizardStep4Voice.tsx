'use client';

import { useState } from 'react';
import { updateAgentConfiguration, generateVoicePreview } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

const voiceOptions = [
  { value: 'tom', label: 'Tom', description: 'A friendly mid thirties voice', elevenLabsId: 'Fahco4VZzobUeiPqni1S', recommended: true },
  { value: 'leah', label: 'Leah', description: 'A pleasantly clear British female voice', elevenLabsId: 'rfkTsdZrVWEVhDycUYn9', recommended: true },
  { value: 'sophie', label: 'Sophie', description: 'A clear and conversational female voice', elevenLabsId: 'fq1SdXsX6OokE10pJ4Xw', recommended: false },
  { value: 'gemma', label: 'Gemma', description: 'A modern Northern English friendly female voice', elevenLabsId: 'IosqM5LMIzqPfT0efhhy', recommended: false },
  { value: 'isobel', label: 'Isobel', description: 'Scottish female voice, youthful and warm', elevenLabsId: 'h8eW5xfRUGVJrZhAFxqK', recommended: false },
  { value: 'fraser', label: 'Fraser', description: 'A soft male Scottish Glaswegian voice', elevenLabsId: 'v2zbX16tJNtRIx8rSHDM', recommended: false },
  { value: 'amelia', label: 'Amelia', description: 'A British female voice', elevenLabsId: '21m00Tcm4TlvDq8ikWAM', recommended: false },
];

interface WizardStep4VoiceProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  greetingText: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep4Voice({
  data,
  updateData,
  garageId,
  greetingText,
  onNext,
  onPrevious,
}: WizardStep4VoiceProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

  const handlePlayVoice = async (voiceValue: string) => {
    try {
      // Stop currently playing audio
      if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
      }

      setPlayingVoice(voiceValue);
      setError(null);

      // Generate preview - pass voice name, not ElevenLabs ID
      const blob = await generateVoicePreview(voiceValue, garageId);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      audio.onended = () => {
        setPlayingVoice(null);
        setError(null); // Clear any previous errors
        URL.revokeObjectURL(url);
      };

      audio.onerror = () => {
        setPlayingVoice(null);
        setError('Failed to play voice preview');
        URL.revokeObjectURL(url);
      };

      setAudioElement(audio);
      await audio.play();
      // Clear error on successful play
      setError(null);
    } catch (err) {
      console.error('Failed to play voice:', err);
      setError('Failed to play voice preview');
      setPlayingVoice(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    // Stop any playing audio
    if (audioElement) {
      audioElement.pause();
      audioElement.src = '';
    }

    try {
      await updateAgentConfiguration({
        branchName: data.branchName || '',
        phoneNumber: data.phoneNumber || '',
        emailAddress: data.emailAddress || '',
        branchAddress: data.branchAddress || '',
        websiteUrl: data.websiteUrl || '',
        weeklyOpeningHours: data.weeklyOpeningHours,
        holidayClosures: data.holidayClosures || '',
        greetingLine: data.greetingLine || '',
        voice: data.voice,
        notificationEmails: data.notificationEmails || [],
        tonePreference: 'standard',
        allowFastFitOnly: data.allowFastFitOnly,
        enableSmsBookingLinks: data.enableSmsBookingLinks,
      } as any, garageId);
      onNext();
    } catch (err) {
      console.error('Failed to save voice:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Choose Your Agent's Voice</h2>
        <p className="mt-2 text-slate-400">
          Select the voice that best represents your business.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          {voiceOptions.map((voice) => (
            <div
              key={voice.value}
              className={`flex items-center justify-between rounded-lg border p-4 transition-colors ${
                voice.recommended
                  ? data.voice === voice.value
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-amber-500 bg-amber-500/5 hover:border-amber-400'
                  : data.voice === voice.value
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 bg-slate-800 hover:border-slate-600'
              }`}
            >
              <label className="flex flex-1 cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="voice"
                  value={voice.value}
                  checked={data.voice === voice.value}
                  onChange={() => updateData({ voice: voice.value })}
                  className="mt-1 h-4 w-4 text-blue-600"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-200">{voice.label}</span>
                    {voice.recommended && (
                      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-400">
                        Recommended
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-400">{voice.description}</div>
                </div>
              </label>
              <button
                type="button"
                onClick={() => handlePlayVoice(voice.value)}
                disabled={playingVoice !== null}
                className="ml-4 flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-600 disabled:opacity-50"
              >
                {playingVoice === voice.value ? (
                  <>
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
                    Playing...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    Preview
                  </>
                )}
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-4">
          <button
            type="button"
            onClick={onPrevious}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-6 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Previous
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Next'}
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

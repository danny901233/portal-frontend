'use client';

// Attaching files to an outbound ticket email, and showing the ones already sent.
//
// Upload happens as the file is chosen, not when the message is sent: a 9MB PDF uploading
// while the reply is still being typed is time nobody waits for, and a file that is going to
// be refused should say so immediately rather than after the reply is written.
//
// Shared by the reply box and the New-email modal. Both pass the ids they are holding to
// their own send call, which is the only thing either of them has to remember.

import { useRef, useState } from 'react';

import {
  getTicketAttachmentUrl,
  uploadTicketAttachment,
  type TicketAttachment,
} from '../lib/api';

export const prettyBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
};

/** What the reply box and the compose modal both need to hold. */
export interface AttachmentUploads {
  attached: TicketAttachment[];
  ids: string[];
  uploading: boolean;
  error: string | null;
  add: (files: FileList | null) => Promise<void>;
  remove: (id: string) => void;
  reset: () => void;
  clearError: () => void;
}

export function useAttachmentUploads(): AttachmentUploads {
  const [attached, setAttached] = useState<TicketAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setUploading(true);
    try {
      // One at a time, so a rejected third file does not discard the two that were fine.
      for (const file of Array.from(files)) {
        try {
          const { attachment } = await uploadTicketAttachment(file);
          setAttached((prev) => [...prev, attachment]);
        } catch (err) {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setError(msg ?? `${file.name} could not be attached.`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  // Dropped from the message, not deleted from the bucket — the daily sweep collects
  // anything that was never sent.
  const remove = (id: string) => setAttached((prev) => prev.filter((a) => a.id !== id));

  return {
    attached,
    ids: attached.map((a) => a.id),
    uploading,
    error,
    add,
    remove,
    reset: () => { setAttached([]); setError(null); },
    clearError: () => setError(null),
  };
}

/** The pill that opens the file picker, styled to sit in the reply toolbar. */
export function AttachButton({ uploads, disabled }: { uploads: AttachmentUploads; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const count = uploads.attached.length;
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled || uploads.uploading}
        className={`rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${
          count ? 'bg-slate-200 text-slate-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
        }`}
        title="Attach a file — PDF, image, Word, Excel or CSV, up to 10MB each"
      >
        {uploads.uploading ? 'Attaching…' : `Attach${count ? ` (${count})` : ''}`}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void uploads.add(e.target.files);
          // Cleared so choosing the same file twice in a row still fires a change.
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Files staged on the message being written, each removable before it goes. */
export function PendingAttachments({ uploads }: { uploads: AttachmentUploads }) {
  if (!uploads.attached.length && !uploads.error) return null;
  return (
    <div className="mb-2 space-y-1">
      {uploads.attached.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {uploads.attached.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
            >
              <span className="max-w-[16rem] truncate" title={a.filename}>{a.filename}</span>
              <span className="text-slate-400">{prettyBytes(a.size)}</span>
              <button
                type="button"
                onClick={() => uploads.remove(a.id)}
                className="text-slate-400 hover:text-red-600"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploads.error && (
        <p className="flex items-start gap-2 text-xs text-red-600">
          <span className="flex-1">{uploads.error}</span>
          <button type="button" onClick={uploads.clearError} className="text-red-400 hover:text-red-600">
            dismiss
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Files that went with a message already sent. Clicking fetches a short-lived link.
 *
 * `tone` exists because a staff reply's bubble is solid brand blue: slate-on-white chips
 * disappear into it, so the dark variant inverts to translucent white instead.
 */
export function SentAttachments({
  attachments,
  tone = 'light',
}: {
  attachments: TicketAttachment[];
  tone?: 'light' | 'dark';
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const { url } = await getTicketAttachmentUrl(id);
      // The presigned URL is good for ten minutes and is never stored.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('That file could not be opened.');
    } finally {
      setBusyId(null);
    }
  };

  if (!attachments.length) return null;
  const dark = tone === 'dark';
  return (
    <div className={`mt-2 border-t pt-2 ${dark ? 'border-white/25' : 'border-slate-200/70'}`}>
      <ul className="flex flex-wrap gap-1.5">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => void open(a.id)}
              disabled={busyId === a.id}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${
                dark
                  ? 'border-white/30 bg-white/10 text-white hover:bg-white/20'
                  : 'border-slate-200 bg-white/70 text-slate-700 hover:border-brand-600 hover:text-brand-700'
              }`}
            >
              <span className="max-w-[14rem] truncate" title={a.filename}>{a.filename}</span>
              <span className={dark ? 'text-brand-100' : 'text-slate-400'}>{prettyBytes(a.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className={`mt-1 text-xs ${dark ? 'text-red-200' : 'text-red-600'}`}>{error}</p>}
    </div>
  );
}

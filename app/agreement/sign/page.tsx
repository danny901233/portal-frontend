'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  fetchAgreementByToken,
  fetchPendingAgreement,
  signAgreement,
  signAgreementByToken,
  type AgreementSummary,
} from '../../lib/api';
import { getSessionToken } from '../../lib/auth';

export default function AgreementSignPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AgreementSignInner />
    </Suspense>
  );
}

function AgreementSignInner() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token');

  const [agreement, setAgreement] = useState<AgreementSummary | null>(null);
  const [html, setHtml] = useState<string>('');
  const [css, setCss] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [signedByName, setSignedByName] = useState('');
  const [signedByPosition, setSignedByPosition] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const contractRef = useRef<HTMLDivElement | null>(null);

  // ---------- load ----------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    const load = async () => {
      try {
        if (token) {
          const res = await fetchAgreementByToken(token);
          if (cancelled) return;
          setAgreement(res.agreement);
          setHtml(res.html);
          setCss(res.css);
          setCustomerEmail(res.customerEmail);
        } else {
          if (!getSessionToken()) {
            router.replace('/login?next=/agreement/sign');
            return;
          }
          const res = await fetchPendingAgreement();
          if (cancelled) return;
          if (!res.agreement) {
            // Nothing to sign — send them home.
            router.replace('/dashboard');
            return;
          }
          setAgreement(res.agreement);
          setHtml(res.html ?? '');
          setCss(res.css ?? '');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load agreement.';
        if (!cancelled) setLoadError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [router, token]);

  const todayStr = useMemo(
    () => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date()),
    []
  );

  const monthlyTotal = agreement ? agreement.licenceFeeGbp * agreement.centresCount : 0;

  const canSubmit =
    !!agreement &&
    signedByName.trim().length > 1 &&
    signedByPosition.trim().length > 1 &&
    !!signatureDataUrl &&
    accepted &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreement || !canSubmit || !signatureDataUrl) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        signedByName: signedByName.trim(),
        signedByPosition: signedByPosition.trim(),
        signatureDataUrl,
      };
      const result = token
        ? await signAgreementByToken(token, payload)
        : await signAgreement(agreement.id, payload);
      setDone(true);
      // Public-signup customers (magic-link path) now go to Stripe Checkout
      // to pay for their first month before being onboarded. The backend
      // returns the URL on the sign response.
      const checkoutUrl = (result as { checkoutUrl?: string | null }).checkoutUrl;
      if (token && checkoutUrl) {
        setTimeout(() => { window.location.href = checkoutUrl; }, 1100);
        return;
      }
      // For signed-in users (no magic-link token), continue onboarding without
      // a re-login: DD setup if still needed, otherwise the dashboard.
      if (!token) {
        const dest = result.nextStep === 'payment' ? '/setup-payment' : '/calls';
        setTimeout(() => router.replace(dest), 2000);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setSubmitError(e?.response?.data?.error ?? 'We couldn\'t record your signature. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- render states ----------
  if (loading) return <FullPageSpinner />;

  if (loadError) {
    return (
      <Frame>
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center">
          <h1 className="text-lg font-semibold text-rose-900">We couldn&rsquo;t load this agreement</h1>
          <p className="mt-2 text-sm text-rose-700">{loadError}</p>
          <p className="mt-4 text-sm text-rose-700">
            If this link came from us by email, it may have expired. Reply to that email and we&rsquo;ll send a fresh one.
          </p>
        </div>
      </Frame>
    );
  }

  if (done) {
    // Three distinct success flows:
    //   • token path + Stripe Checkout: brief confirmation while we redirect
    //     them to pay for their first month.
    //   • token path without Checkout (fallback): "check your email" screen
    //     for accounts predating the Stripe rollout / where Stripe is down.
    //   • no-token path (existing portal user signed it themselves): submit
    //     handler is already redirecting to /setup-payment or /calls.
    return (
      <Frame>
        <div className="rounded-3xl border border-emerald-200 bg-white p-6 sm:p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
              <svg className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold text-slate-900">Agreement signed.</h1>
              <p className="mt-1 text-sm text-slate-600">
                Thanks {signedByName} — a PDF copy is on its way to your inbox.
              </p>
            </div>
          </div>

          {token ? (
            <>
              <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">What happens next</p>
                <ol className="mt-3 space-y-3 text-sm text-slate-700">
                  <NextStep n={1} title="Check your email for your login" body="We've sent your portal username and a temporary password." />
                  <NextStep n={2} title="Sign in and set your own password" body="You'll be prompted to change it on first login." />
                  <NextStep n={3} title="Set up your Direct Debit" body="Takes 30 seconds — we'll bill on the day your minutes go live." />
                  <NextStep n={4} title="Complete the setup wizard" body="Pick your voice, branch hours, greetings and we'll spin up your number." />
                </ol>
              </div>

              <a
                href="/login"
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
              >
                Open the portal
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd"/></svg>
              </a>
              <p className="mt-3 text-center text-xs text-slate-500">
                Can&rsquo;t find the email? Check your spam folder, or write to{' '}
                <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>.
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-600">Setting up your Direct Debit next&hellip;</p>
          )}
        </div>
      </Frame>
    );
  }

  if (!agreement) return null;

  return (
    <Frame>
      <style>{css}</style>

      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">ReceptionMate</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Sign your service agreement</h1>
        <p className="mt-1 text-sm text-slate-600">
          {customerEmail ? <>This agreement is for <strong>{customerEmail}</strong>. </> : null}
          Have a read through, then complete your name and position below to sign.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Commercial summary</h2>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-5 sm:grid-cols-3">
          <SummaryItem label="Centres" value={String(agreement.centresCount)} />
          <SummaryItem label="Licence fee" value={`${formatGbp(agreement.licenceFeeGbp)}/centre/mo`} />
          <SummaryItem label="Setup fee" value={agreement.setupFeeGbp > 0 ? formatGbp(agreement.setupFeeGbp) : 'Waived'} />
          <SummaryItem label="Monthly total" value={`${formatGbp(monthlyTotal)} + VAT`} />
          <SummaryItem label="Licences" value={agreement.licences.map(capitalise).join(', ')} />
          <SummaryItem
            label="Go-live"
            value={agreement.goLiveDate ? formatDate(agreement.goLiveDate) : 'To be confirmed'}
          />
        </dl>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Full agreement</h2>
          <span className="text-xs text-slate-500">Version {agreement.version}</span>
        </div>
        <div
          ref={contractRef}
          className="max-h-[60vh] overflow-y-auto p-6"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </section>

      <form onSubmit={handleSubmit} className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Sign electronically</h2>
        <p className="mt-1 text-xs text-slate-500">Today&rsquo;s date: {todayStr}</p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Full name"
            placeholder="e.g. Daniel Tyldesley"
            value={signedByName}
            onChange={setSignedByName}
            required
          />
          <Field
            label="Position / role"
            placeholder="e.g. Director"
            value={signedByPosition}
            onChange={setSignedByPosition}
            required
          />
        </div>

        <div className="mt-5">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-600">Draw your signature</label>
          <SignaturePad value={signatureDataUrl} onChange={setSignatureDataUrl} />
        </div>

        <label className="mt-5 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
          />
          <span>
            I confirm I have authority to sign this agreement on behalf of{' '}
            <strong>{agreement.clientName}</strong>, that the information above is correct, and I accept the terms of
            the agreement. I understand this constitutes my electronic signature.
          </span>
        </label>

        {submitError ? (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{submitError}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {submitting ? 'Signing…' : 'Sign agreement'}
          </button>
        </div>
      </form>

      <p className="mt-6 text-center text-xs text-slate-500">
        Questions? Email <a href="mailto:hello@receptionmate.co.uk" className="text-brand-600 hover:underline">hello@receptionmate.co.uk</a>.
      </p>
    </Frame>
  );
}

// ---------- helpers ----------

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-10">
      <div className="mx-auto w-full max-w-3xl px-4">{children}</div>
    </div>
  );
}

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-brand-600" />
        <p className="mt-4 text-sm text-slate-500">Loading your agreement…</p>
      </div>
    </div>
  );
}

function NextStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
        {n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-slate-900">{title}</span>
        <span className="mt-0.5 block text-xs text-slate-600">{body}</span>
      </span>
    </li>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
  required,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-600">{label}</span>
      <input
        type="text"
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
    </label>
  );
}

function SignaturePad({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const inkRef = useRef(false);

  // Set up canvas resolution to match its CSS size × DPR
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0f172a';
    }
  }, []);

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    canvas.setPointerCapture(e.pointerId);
    lastPoint.current = pointAt(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !lastPoint.current) return;
    const p = pointAt(e);
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint.current = p;
    inkRef.current = true;
  };

  const finishStroke = () => {
    drawing.current = false;
    lastPoint.current = null;
    if (inkRef.current && canvasRef.current) {
      onChange(canvasRef.current.toDataURL('image/png'));
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.scale(dpr, dpr);
    inkRef.current = false;
    onChange(null);
  };

  return (
    <div>
      <div className="mt-1.5 rounded-xl border border-slate-300 bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerLeave={finishStroke}
          className="block h-44 w-full touch-none rounded-xl"
          style={{ touchAction: 'none', cursor: 'crosshair' }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {value ? 'Looks good — your signature is captured.' : 'Use your mouse, finger or stylus to sign above.'}
        </p>
        <button
          type="button"
          onClick={clear}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function formatGbp(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(iso));
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

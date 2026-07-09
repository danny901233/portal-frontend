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
import { useLang } from '@/app/i18n/LocaleProvider';
import TrialCardForm from '@/app/components/TrialCardForm';

export default function AgreementSignPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AgreementSignInner />
    </Suspense>
  );
}

function AgreementSignInner() {
  const lang = useLang();
  const c = {
    en: {
      failedLoad: 'Failed to load agreement.',
      couldntRecord: "We couldn't record your signature. Please try again.",
      loadErrorTitle: 'We couldn’t load this agreement',
      loadErrorHelp: 'If this link came from us by email, it may have expired. Reply to that email and we’ll send a fresh one.',
      signedTitle: 'Agreement signed.',
      thanks: (name: string) => `Thanks ${name} — a PDF copy is on its way to your inbox.`,
      whatHappensNext: 'What happens next',
      step1Title: 'Check your email for your login',
      step1Body: "We've sent your portal username and a temporary password.",
      step2Title: 'Sign in and set your own password',
      step2Body: "You'll be prompted to change it on first login.",
      step3Title: 'Set up your Direct Debit',
      step3Body: "Takes 30 seconds — we'll bill on the day your minutes go live.",
      step4Title: 'Complete the setup wizard',
      step4Body: "Pick your voice, branch hours, greetings and we'll spin up your number.",
      openPortal: 'Open the portal',
      cantFindEmail: 'Can’t find the email? Check your spam folder, or write to',
      settingUpDd: 'Setting up your Direct Debit next…',
      brand: 'ReceptionMate',
      signYourAgreement: 'Sign your service agreement',
      agreementForPrefix: 'This agreement is for',
      readThrough: 'Have a read through, then complete your name and position below to sign.',
      commercialSummary: 'Commercial summary',
      centres: 'Centres',
      licenceFee: 'Licence fee',
      perCentrePerMo: '/centre/mo',
      setupFee: 'Setup fee',
      waived: 'Waived',
      monthlyTotal: 'Monthly total',
      licences: 'Licences',
      goLive: 'Go-live',
      toBeConfirmed: 'To be confirmed',
      fullAgreement: 'Full agreement',
      versionLabel: 'Version',
      signElectronically: 'Sign electronically',
      todaysDate: 'Today’s date:',
      fullName: 'Full name',
      fullNamePlaceholder: 'e.g. Daniel Tyldesley',
      position: 'Position / role',
      positionPlaceholder: 'e.g. Director',
      drawSignature: 'Draw your signature',
      confirmPrefix: 'I confirm I have authority to sign this agreement on behalf of',
      confirmSuffix: ', that the information above is correct, and I accept the terms of the agreement. I understand this constitutes my electronic signature.',
      signing: 'Signing…',
      signAgreement: 'Sign agreement',
      questions: 'Questions? Email',
    },
    fr: {
      failedLoad: 'Échec du chargement du contrat.',
      couldntRecord: "Nous n'avons pas pu enregistrer votre signature. Veuillez réessayer.",
      loadErrorTitle: 'Nous n’avons pas pu charger ce contrat',
      loadErrorHelp: 'Si ce lien vous a été envoyé par e-mail, il a peut-être expiré. Répondez à cet e-mail et nous vous en enverrons un nouveau.',
      signedTitle: 'Contrat signé.',
      thanks: (name: string) => `Merci ${name} — une copie PDF est en route vers votre boîte de réception.`,
      whatHappensNext: 'Prochaines étapes',
      step1Title: 'Consultez votre e-mail pour vos identifiants',
      step1Body: 'Nous vous avons envoyé votre nom d’utilisateur du portail et un mot de passe temporaire.',
      step2Title: 'Connectez-vous et définissez votre propre mot de passe',
      step2Body: 'Vous serez invité à le modifier lors de votre première connexion.',
      step3Title: 'Configurez votre prélèvement automatique',
      step3Body: 'Cela prend 30 secondes — nous facturerons le jour où vos minutes seront activées.',
      step4Title: 'Terminez l’assistant de configuration',
      step4Body: 'Choisissez votre voix, les horaires de votre agence, les messages d’accueil et nous activerons votre numéro.',
      openPortal: 'Ouvrir le portail',
      cantFindEmail: 'Vous ne trouvez pas l’e-mail ? Vérifiez votre dossier de courrier indésirable ou écrivez à',
      settingUpDd: 'Configuration de votre prélèvement automatique…',
      brand: 'ReceptionMate',
      signYourAgreement: 'Signez votre contrat de service',
      agreementForPrefix: 'Ce contrat concerne',
      readThrough: 'Lisez-le attentivement, puis renseignez votre nom et votre fonction ci-dessous pour signer.',
      commercialSummary: 'Récapitulatif commercial',
      centres: 'Centres',
      licenceFee: 'Frais de licence',
      perCentrePerMo: '/centre/mois',
      setupFee: 'Frais de configuration',
      waived: 'Offerts',
      monthlyTotal: 'Total mensuel',
      licences: 'Licences',
      goLive: 'Mise en service',
      toBeConfirmed: 'À confirmer',
      fullAgreement: 'Contrat complet',
      versionLabel: 'Version',
      signElectronically: 'Signer électroniquement',
      todaysDate: 'Date du jour :',
      fullName: 'Nom complet',
      fullNamePlaceholder: 'ex. Daniel Tyldesley',
      position: 'Fonction / poste',
      positionPlaceholder: 'ex. Directeur',
      drawSignature: 'Dessinez votre signature',
      confirmPrefix: 'Je confirme que j’ai le pouvoir de signer ce contrat au nom de',
      confirmSuffix: ', que les informations ci-dessus sont exactes, et j’accepte les conditions du contrat. Je comprends que cela constitue ma signature électronique.',
      signing: 'Signature en cours…',
      signAgreement: 'Signer le contrat',
      questions: 'Des questions ? Écrivez à',
    },
  }[lang];
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
        const message = err instanceof Error ? err.message : c.failedLoad;
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

  // Set once a public-signup customer has signed: holds the SetupIntent client_secret so we render
  // the Stripe card form (custom Payment Element) in-page instead of redirecting to stripe.com.
  const [cardClientSecret, setCardClientSecret] = useState<string | null>(null);
  // One-time token to set their own password after the card (custom flow → no welcome-email reliance).
  const [cardResetToken, setCardResetToken] = useState<string | null>(null);
  // Deferred-account flow: the account is created only after the card, via this pending id.
  const [cardPendingId, setCardPendingId] = useState<string | null>(null);

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
      // Public-signup customers (magic-link path) enter their card on this page via Stripe's
      // Payment Element to start the 14-day trial — no redirect. The backend returns the
      // SetupIntent client_secret; stashing it flips the success screen into the card form.
      const clientSecret = (result as { checkoutClientSecret?: string | null }).checkoutClientSecret;
      if (token && clientSecret) {
        setCardResetToken((result as { passwordSetupToken?: string | null }).passwordSetupToken ?? null);
        setCardPendingId((result as { pendingSignupId?: string | null }).pendingSignupId ?? null);
        setCardClientSecret(clientSecret);
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
      setSubmitError(e?.response?.data?.error ?? c.couldntRecord);
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
          <h1 className="text-lg font-semibold text-rose-900">{c.loadErrorTitle}</h1>
          <p className="mt-2 text-sm text-rose-700">{loadError}</p>
          <p className="mt-4 text-sm text-rose-700">
            {c.loadErrorHelp}
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
              <h1 className="text-xl font-semibold text-slate-900">{c.signedTitle}</h1>
              <p className="mt-1 text-sm text-slate-600">
                {c.thanks(signedByName)}
              </p>
            </div>
          </div>

          {token && cardClientSecret ? (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-slate-900">Start your 14-day free trial</h2>
              <p className="mt-1 text-xs text-slate-500">
                Add your card to activate. You won’t be charged today — the trial is free for 14 days.
              </p>
              <div className="mt-4">
                <TrialCardForm clientSecret={cardClientSecret} resetToken={cardResetToken} pendingSignupId={cardPendingId} />
              </div>
            </div>
          ) : token ? (
            <>
              <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{c.whatHappensNext}</p>
                <ol className="mt-3 space-y-3 text-sm text-slate-700">
                  <NextStep n={1} title={c.step1Title} body={c.step1Body} />
                  <NextStep n={2} title={c.step2Title} body={c.step2Body} />
                  <NextStep n={3} title={c.step3Title} body={c.step3Body} />
                  <NextStep n={4} title={c.step4Title} body={c.step4Body} />
                </ol>
              </div>

              <a
                href="/login"
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
              >
                {c.openPortal}
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd"/></svg>
              </a>
              <p className="mt-3 text-center text-xs text-slate-500">
                {c.cantFindEmail}{' '}
                <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>.
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-600">{c.settingUpDd}</p>
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
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">{c.brand}</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{c.signYourAgreement}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {customerEmail ? <>{c.agreementForPrefix} <strong>{customerEmail}</strong>. </> : null}
          {c.readThrough}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{c.commercialSummary}</h2>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-5 sm:grid-cols-3">
          <SummaryItem label={c.centres} value={String(agreement.centresCount)} />
          <SummaryItem label={c.licenceFee} value={`${formatGbp(agreement.licenceFeeGbp)}${c.perCentrePerMo}`} />
          <SummaryItem label={c.setupFee} value={agreement.setupFeeGbp > 0 ? formatGbp(agreement.setupFeeGbp) : c.waived} />
          <SummaryItem label={c.monthlyTotal} value={`${formatGbp(monthlyTotal)} + VAT`} />
          <SummaryItem label={c.licences} value={agreement.licences.map(capitalise).join(', ')} />
          <SummaryItem
            label={c.goLive}
            value={agreement.goLiveDate ? formatDate(agreement.goLiveDate) : c.toBeConfirmed}
          />
        </dl>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{c.fullAgreement}</h2>
          <span className="text-xs text-slate-500">{c.versionLabel} {agreement.version}</span>
        </div>
        <div
          ref={contractRef}
          className="max-h-[60vh] overflow-y-auto p-6"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </section>

      <form onSubmit={handleSubmit} className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">{c.signElectronically}</h2>
        <p className="mt-1 text-xs text-slate-500">{c.todaysDate} {todayStr}</p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={c.fullName}
            placeholder={c.fullNamePlaceholder}
            value={signedByName}
            onChange={setSignedByName}
            required
          />
          <Field
            label={c.position}
            placeholder={c.positionPlaceholder}
            value={signedByPosition}
            onChange={setSignedByPosition}
            required
          />
        </div>

        <div className="mt-5">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-600">{c.drawSignature}</label>
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
            {c.confirmPrefix}{' '}
            <strong>{agreement.clientName}</strong>{c.confirmSuffix}
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
            {submitting ? c.signing : c.signAgreement}
          </button>
        </div>
      </form>

      <p className="mt-6 text-center text-xs text-slate-500">
        {c.questions} <a href="mailto:hello@receptionmate.co.uk" className="text-brand-600 hover:underline">hello@receptionmate.co.uk</a>.
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
  const lang = useLang();
  const c = { en: { loading: 'Loading your agreement…' }, fr: { loading: 'Chargement de votre contrat…' } }[lang];
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-brand-600" />
        <p className="mt-4 text-sm text-slate-500">{c.loading}</p>
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
  const lang = useLang();
  const c = {
    en: { captured: 'Looks good — your signature is captured.', prompt: 'Use your mouse, finger or stylus to sign above.', clear: 'Clear' },
    fr: { captured: 'Parfait — votre signature est enregistrée.', prompt: 'Utilisez votre souris, votre doigt ou un stylet pour signer ci-dessus.', clear: 'Effacer' },
  }[lang];
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
          {value ? c.captured : c.prompt}
        </p>
        <button
          type="button"
          onClick={clear}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {c.clear}
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

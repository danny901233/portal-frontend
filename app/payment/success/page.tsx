// Landing page after a successful Stripe Checkout. The webhook does the real
// work (provisions Twilio, sends welcome email) — this page is purely visual.
import { cookies } from 'next/headers';
import { LOCALE_STORAGE_KEY } from '../../i18n/messages';

export default async function PaymentSuccessPage() {
  const lang = (await cookies()).get(LOCALE_STORAGE_KEY)?.value === 'fr' ? 'fr' : 'en';
  const c = {
    en: {
      title: 'Payment received.',
      sub: 'You’re all set. We’ve started setting up your number and we’ll email your portal login in the next minute or two.',
      s1t: 'Check your email for your login',
      s1b: 'We’re sending your portal username and a temporary password right now.',
      s2t: 'Sign in and complete your setup wizard',
      s2b: 'Pick your voice, branch hours and greetings.',
      s3t: 'Set up Direct Debit for future months',
      s3b: 'Today’s payment covers your first month — Direct Debit takes over from month two.',
      cta: 'Open the portal',
      help1: 'No login email after a minute? Check spam, or write to',
    },
    fr: {
      title: 'Paiement reçu.',
      sub: 'Tout est prêt. Nous avons commencé à configurer votre numéro et nous vous enverrons vos identifiants du portail par e-mail dans une minute ou deux.',
      s1t: 'Consultez votre e-mail pour vos identifiants',
      s1b: 'Nous vous envoyons dès maintenant votre nom d’utilisateur et un mot de passe temporaire.',
      s2t: 'Connectez-vous et terminez l’assistant de configuration',
      s2b: 'Choisissez votre voix, les horaires de l’établissement et les messages d’accueil.',
      s3t: 'Mettez en place le prélèvement automatique pour les mois suivants',
      s3b: 'Le paiement d’aujourd’hui couvre votre premier mois — le prélèvement automatique prend le relais dès le deuxième mois.',
      cta: 'Ouvrir le portail',
      help1: 'Pas d’e-mail après une minute ? Vérifiez vos spams ou écrivez à',
    },
  }[lang];
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-3xl border border-emerald-200 bg-white p-8 shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-bold text-slate-900">{c.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{c.sub}</p>

        <ol className="mt-6 space-y-3 rounded-2xl bg-slate-50 p-5 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">1</span>
            <span><span className="block font-semibold text-slate-900">{c.s1t}</span><span className="mt-0.5 block text-xs text-slate-600">{c.s1b}</span></span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">2</span>
            <span><span className="block font-semibold text-slate-900">{c.s2t}</span><span className="mt-0.5 block text-xs text-slate-600">{c.s2b}</span></span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">3</span>
            <span><span className="block font-semibold text-slate-900">{c.s3t}</span><span className="mt-0.5 block text-xs text-slate-600">{c.s3b}</span></span>
          </li>
        </ol>

        <a
          href="/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
        >
          {c.cta}
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd"/></svg>
        </a>
        <p className="mt-3 text-center text-xs text-slate-500">
          {c.help1}{' '}
          <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>.
        </p>
      </div>
    </div>
  );
}

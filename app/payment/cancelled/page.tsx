// Landing page when the customer hits Stripe's "back" / cancels the
// Checkout session before paying. They've already signed the agreement at
// this point; the magic-link email contains a Re-Pay link they can use to
// restart the Checkout.
import { cookies } from 'next/headers';
import { LOCALE_STORAGE_KEY } from '../../i18n/messages';

export default async function PaymentCancelledPage() {
  const lang = (await cookies()).get(LOCALE_STORAGE_KEY)?.value === 'fr' ? 'fr' : 'en';
  const c = {
    en: {
      title: 'Payment cancelled.',
      sub: 'No charge was made. Your account and signed agreement are still here — you can finish setting up whenever you’re ready.',
      body1: 'Open the original sign-up email from us and click',
      reviewSign: 'Review and sign',
      body2: 'again — that link will take you back to the payment step.',
      cta: 'Need help? Email the team',
    },
    fr: {
      title: 'Paiement annulé.',
      sub: 'Aucun montant n’a été débité. Votre compte et votre contrat signé sont toujours là — vous pouvez terminer la configuration quand vous le souhaitez.',
      body1: 'Ouvrez l’e-mail d’inscription que nous vous avons envoyé et cliquez sur',
      reviewSign: 'Vérifier et signer',
      body2: 'à nouveau — ce lien vous ramènera à l’étape de paiement.',
      cta: 'Besoin d’aide ? Écrivez à l’équipe',
    },
  }[lang];
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.947-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-bold text-slate-900">{c.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{c.sub}</p>
        <p className="mt-4 text-sm text-slate-600">
          {c.body1} <strong>{c.reviewSign}</strong>{' '}
          {c.body2}
        </p>

        <a
          href="mailto:hello@receptionmate.co.uk"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
        >
          {c.cta}
        </a>
      </div>
    </div>
  );
}

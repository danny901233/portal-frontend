'use client';

// Step-by-step "tour" through the agent-setup pages. Activated by ?tour=1 in
// the URL — the SetupWizard's "Set up my agent" button kicks it off. Each
// step lives on a real agent-setup page so the user is filling things in for
// real as they go.

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

interface TourStep {
  path: string;
  title: string;
  hint: string;
}

const TOUR: TourStep[] = [
  {
    path: '/agent-setup/company-information',
    title: 'Company information',
    hint: 'Start with the basics — branch name, phone, address. The agent uses these so it can introduce itself correctly and quote your details on calls.',
  },
  {
    path: '/agent-setup/opening-hours',
    title: 'Opening hours',
    hint: 'Tell the agent when you’re open. Out-of-hours calls are handled differently — usually a polite message + voicemail-style booking request.',
  },
  {
    path: '/agent-setup/voice',
    title: 'Voice & tone',
    hint: 'Pick a voice that fits your brand. Tap ▶ on each card to hear a sample. Tone affects pace and warmth — “Standard” works for most garages.',
  },
  {
    path: '/agent-setup/voice',
    title: 'Greeting',
    hint: 'Customise the first line the agent says when answering. Short and warm beats long and corporate — “Hi, you’ve reached Acme Garage…” is plenty.',
  },
  {
    path: '/agent-setup/voice',
    title: 'Pronunciations',
    hint: 'Tell the agent how to say tricky words — your brand name, local place names, unusual surnames. Spell it like you’d sound it out.',
  },
  {
    path: '/agent-setup/bookings-transfers',
    title: 'Booking rules',
    hint: 'How do you want bookings handled? Set the lead time (how far ahead a customer can book) and whether you only do fast-fit work.',
  },
  {
    path: '/agent-setup/bookings-transfers',
    title: 'Call transfers',
    hint: 'Add a fallback number for calls the agent can’t handle (e.g. complex complaints or warranty claims). Leave blank to keep all calls AI-handled.',
  },
  {
    path: '/agent-setup/questions',
    title: 'Smart questions',
    hint: 'Pick the info you want collected on every booking call — vehicle reg, postcode, preferred contact. Mark which are required vs nice-to-have.',
  },
  {
    path: '/agent-setup/questions',
    title: 'FAQs',
    hint: 'Add the questions you get all the time and your standard answers — directions, payment methods, courtesy cars. The agent uses these word-for-word.',
  },
  {
    path: '/agent-setup/rules',
    title: 'Custom rules',
    hint: 'Anything unusual? Examples: “Always offer a courtesy car for MOT bookings”, or “Air-con regas — tell callers to just turn up, no booking needed”.',
  },
  {
    path: '/agent-setup/training',
    title: 'Training',
    hint: 'Upload your price list, service menu or brochures (PDF/Word). The agent reads them so it can answer detailed questions about what you offer.',
  },
  {
    path: '/agent-setup/integrations',
    title: 'Integrations',
    hint: 'Connect HubSpot so the agent can push new customer details and bookings straight into your CRM. You can skip this and come back later.',
  },
  {
    path: '/agent-setup/notifications',
    title: 'Notifications',
    hint: 'Last step — who should get an email after every call? Add manager / reception inboxes here. One email per line; leave blank to disable.',
  },
];

export default function TourBanner() {
  return (
    <Suspense fallback={null}>
      <TourBannerInner />
    </Suspense>
  );
}

function TourBannerInner() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const tourParam = search?.get('tour');
  const tourActive = tourParam !== null && tourParam !== '';
  const currentStepIndex = useMemo(() => {
    if (!tourActive) return -1;
    const fromUrl = Number(tourParam);
    if (Number.isFinite(fromUrl) && fromUrl >= 1 && fromUrl <= TOUR.length) {
      return fromUrl - 1;
    }
    const fromPath = TOUR.findIndex((s) => s.path === pathname);
    return fromPath >= 0 ? fromPath : 0;
  }, [tourActive, tourParam, pathname]);

  if (!tourActive || currentStepIndex < 0) return null;

  const step = TOUR[currentStepIndex];
  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex === TOUR.length - 1;
  const progressPct = Math.round(((currentStepIndex + 1) / TOUR.length) * 100);

  // If the user manually navigated to a page that doesn't match the current step,
  // gently nudge them — show the banner but link them to the right page.
  const onCorrectPage = pathname === step.path;

  const go = (newIndex: number) => {
    const next = TOUR[newIndex];
    router.push(`${next.path}?tour=${newIndex + 1}`);
  };
  const skip = () => router.push(pathname ?? '/agent-setup');
  const finish = () => router.push('/dashboard');

  return (
    <div className="sticky top-0 z-30 -mt-8 mb-6 border-b border-brand-100 bg-gradient-to-br from-brand-50 to-white px-8 py-4 shadow-sm">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
            {currentStepIndex + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Step {currentStepIndex + 1} of {TOUR.length}: {step.title}
              </h3>
              <button
                type="button"
                onClick={skip}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-white hover:text-slate-700"
              >
                Skip tour
              </button>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{step.hint}</p>
            {!onCorrectPage ? (
              <Link
                href={`${step.path}?tour=${currentStepIndex + 1}`}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
              >
                Go to {step.title} →
              </Link>
            ) : null}
          </div>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-brand-100">
          <div className="h-full bg-brand-600 transition-all duration-500" style={{ width: `${progressPct}%` }} />
        </div>

        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={isFirst}
            onClick={() => go(currentStepIndex - 1)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Previous
          </button>
          {isLast ? (
            <button
              type="button"
              onClick={finish}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Finish tour ✓
            </button>
          ) : (
            <button
              type="button"
              onClick={() => go(currentStepIndex + 1)}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              Save & next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

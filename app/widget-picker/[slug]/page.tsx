'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { BRANCH_GROUPS } from '../branchGroups';

// Generic landing page for multi-branch garages that share one website. This is the embed
// target instead of /widget/{garageId} directly. Per Dan: ask how they'd like to get in touch
// first (the real widget's own "Message us on..." menu), THEN which branch — because the
// WhatsApp number and phone number differ per branch, and Live Chat needs to know which
// branch's agent to open. Deliberately mirrors the real widget's menu markup so the two
// screens look like one product. Branch lists live in ../branchGroups.ts.
const DEFAULT_COLOR = '#1e3a8a'; // same fallback the real widget's menu uses

if (typeof window !== 'undefined') {
  const link = document.createElement('link');
  link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap';
  link.rel = 'stylesheet';
  document.head.appendChild(link);
}

type Channel = 'whatsapp' | 'chat' | 'phone';
type Step = 'closed' | 'channel' | 'branch';

interface BranchCard {
  garageId: string;
  name: string;
  address?: string;
  primaryColor?: string;
  buttonColor?: string;
  phone?: string | null;
  whatsappNumber?: string | null;
  logoUrl?: string | null;
  logoWidth?: number;
  logoHeight?: number;
  loaded?: boolean;
}

function BranchPickerInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slugParam = params?.slug;
  const slug = typeof slugParam === 'string' ? slugParam : Array.isArray(slugParam) ? slugParam[0] : '';
  const group = BRANCH_GROUPS[slug];

  // The chosen platform lives in the URL, not component state, so the widget's pre-chat
  // back button (and the browser's own back) can return here to the branch list rather
  // than restarting the flow.
  const channelRaw = searchParams.get('channel') || '';
  const channel: Channel | null =
    channelRaw === 'whatsapp' || channelRaw === 'chat' || channelRaw === 'phone' ? channelRaw : null;
  const [opened, setOpened] = useState(() => !!channel);
  const step: Step = !opened ? 'closed' : channel ? 'branch' : 'channel';

  // Seed with the static fallback names so branches are legible on first paint and if the
  // live fetch below fails; the effect overwrites each one with its real configured data.
  const [branches, setBranches] = useState<BranchCard[]>(
    () => group?.branches.map((branch) => ({ garageId: branch.garageId, address: branch.address, name: branch.fallbackName })) ?? [],
  );

  // Pull each branch's live name/branding/contact numbers from the same /api/widget config
  // the real widget reads, so this stays in sync with whatever's set on the Customize page.
  useEffect(() => {
    if (!group) return;
    Promise.all(
      group.branches.map((branch) =>
        fetch(`/api/widget/${branch.garageId}`)
          .then((res) => (res.ok ? res.json() : Promise.reject()))
          .then((data) => ({
            garageId: branch.garageId,
            address: branch.address,
            name: data.name || branch.fallbackName,
            primaryColor: data.primaryColor,
            buttonColor: data.buttonColor,
            phone: data.phone,
            whatsappNumber: data.whatsappNumber,
            logoUrl: data.logoUrl,
            logoWidth: data.logoWidth,
            logoHeight: data.logoHeight,
            loaded: true,
          }))
          .catch(() => ({ garageId: branch.garageId, address: branch.address, name: branch.fallbackName })),
      ),
    ).then(setBranches);
  }, [group]);

  const brand = branches[0];
  const primaryColor = brand?.primaryColor || DEFAULT_COLOR;
  const bubbleColor = brand?.buttonColor || brand?.primaryColor || DEFAULT_COLOR;
  const logoWidth = brand?.logoWidth || 120;
  const logoHeight = brand?.logoHeight || 60;

  // Same resize protocol and the same box the real widget sends, so the embedding page's
  // iframe matches: small while it's just the bubble, roomy once a card is open.
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage(
      step === 'closed'
        ? { type: 'rm-resize', width: '150px', height: '150px' }
        : { type: 'rm-resize', width: '460px', height: '760px' },
      '*',
    );
  }, [step]);

  if (!group) {
    return null;
  }

  // Offer a platform only when EVERY branch can actually be reached on it — otherwise the
  // visitor picks, say, Phone and then finds half the branches missing from the next screen.
  // Judged across the branches whose config loaded, so one failed fetch doesn't empty the menu.
  const loadedBranches = branches.filter((b) => b.loaded);
  const anyWhatsapp = loadedBranches.length > 0 && loadedBranches.every((b) => b.whatsappNumber);
  const anyPhone = loadedBranches.length > 0 && loadedBranches.every((b) => b.phone);
  const visibleBranches =
    channel === 'whatsapp' ? branches.filter((b) => b.whatsappNumber)
    : channel === 'phone' ? branches.filter((b) => b.phone)
    : branches;

  const selectChannel = (next: Channel) => {
    router.push(`/widget-picker/${slug}?channel=${next}`);
  };

  const backToChannel = () => {
    router.push(`/widget-picker/${slug}`);
  };

  const toggleBubble = () => {
    if (opened) {
      setOpened(false);
      if (channel) router.replace(`/widget-picker/${slug}`);
      return;
    }
    setOpened(true);
  };

  const selectBranch = (branch: BranchCard) => {
    if (channel === 'whatsapp' && branch.whatsappNumber) {
      const message = encodeURIComponent('Hi, I would like to get in touch.');
      window.open(`https://wa.me/${branch.whatsappNumber}?text=${message}`, '_blank');
      return;
    }
    if (channel === 'phone' && branch.phone) {
      window.location.href = `tel:${branch.phone}`;
      return;
    }
    // Live chat: hand off to that branch's existing widget, already open on the pre-chat
    // form so the visitor doesn't have to click the bubble again after already picking here.
    // from/channel let that form's back button come back to this branch list.
    window.location.href = `/widget/${branch.garageId}?open=pre-chat&from=${slug}&channel=chat`;
  };

  const optionButton = (key: string, icon: React.ReactNode, iconBg: string, label: string, sub: string | undefined, onClick: () => void) => (
    <button
      key={key}
      onClick={onClick}
      className="w-full flex items-center gap-4 transition-all"
      style={{
        backgroundColor: 'white',
        color: '#333',
        padding: '16px 20px',
        fontSize: '17px',
        borderRadius: '16px',
        border: '2px solid #5DDCC2',
        outline: 'none',
        cursor: 'pointer',
        fontFamily: "'Poppins', sans-serif",
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.backgroundColor = '#f0fdf9';
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.backgroundColor = 'white';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="flex-1 text-left">
        <span className="block font-medium">{label}</span>
        {sub && <span className="block text-sm text-gray-500">{sub}</span>}
      </div>
    </button>
  );

  return (
    <>
      {step !== 'closed' && (
        <div
          className="fixed bottom-28 right-6 z-50 animate-in slide-in-from-bottom-4 duration-200"
          style={{
            width: 'min(380px, calc(100vw - 48px))',
            borderRadius: '32px',
            background: primaryColor,
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
            fontSize: '17px',
            fontFamily: "'Poppins', sans-serif",
            paddingTop: `${Math.max(120, logoHeight + 70)}px`,
            paddingBottom: '40px',
            paddingLeft: '32px',
            paddingRight: '32px',
          }}
        >
          {/* Logo Area - Above the white card */}
          <div className="absolute top-8 left-0 right-0 flex justify-center">
            {brand?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logoUrl}
                alt="Logo"
                style={{ width: `${logoWidth}px`, height: `${logoHeight}px`, objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div
                style={{
                  width: `${logoWidth}px`,
                  height: `${logoHeight}px`,
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  backdropFilter: 'blur(10px)',
                  borderRadius: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: 'rotate(12deg)',
                }}
              >
                <svg style={{ width: `${logoWidth * 0.6}px`, height: `${logoHeight * 0.6}px`, color: 'rgba(255, 255, 255, 0.6)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
            )}
          </div>

          {/* White overlay rectangle */}
          <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '24px 20px 24px', boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)' }}>
            <div className="flex items-center gap-2 mb-5">
              {step === 'branch' && (
                <button
                  onClick={backToChannel}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 0, display: 'flex' }}
                  aria-label="Back"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              <h4 className="text-gray-900 font-medium text-lg" style={{ fontFamily: "'Poppins', sans-serif" }}>
                {step === 'channel' ? 'Message us on...' : 'Select a branch'}
              </h4>
            </div>

            <div className="space-y-3">
              {step === 'channel' ? (
                <>
                  {anyWhatsapp && optionButton(
                    'whatsapp',
                    <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>,
                    '#22c55e',
                    'WhatsApp',
                    undefined,
                    () => selectChannel('whatsapp'),
                  )}
                  {optionButton(
                    'chat',
                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>,
                    primaryColor,
                    'Live Chat',
                    undefined,
                    () => selectChannel('chat'),
                  )}
                  {anyPhone && optionButton(
                    'phone',
                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>,
                    primaryColor,
                    'Phone',
                    undefined,
                    () => selectChannel('phone'),
                  )}
                </>
              ) : (
                visibleBranches.map((branch) =>
                  optionButton(
                    branch.garageId,
                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>,
                    primaryColor,
                    branch.name,
                    branch.address,
                    () => selectBranch(branch),
                  ),
                )
              )}
            </div>
          </div>

          {/* Powered by - outside white rectangle */}
          <div className="mt-10 text-center">
            <a
              href="https://receptionmate.co.uk/home"
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-medium hover:underline"
              style={{ color: 'white', fontFamily: "'Poppins', sans-serif", textDecoration: 'none' }}
            >
              Powered by ReceptionMate
            </a>
          </div>
        </div>
      )}

      {/* Floating bubble — doubles as the close control once a card is open, same as the real widget */}
      <button
        onClick={toggleBubble}
        className="fixed bottom-6 right-6 z-50 flex items-center justify-center transition-all duration-300 ease-out hover:scale-105 active:scale-95"
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          background: bubbleColor,
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 5px 18px 0 rgba(151, 124, 156, 0.2), 0 5px 32px 0 rgba(203, 195, 212, 0.2), 0 8px 58px 0 rgba(216, 212, 221, 0.1)',
        }}
        aria-label={step === 'closed' ? 'Open chat' : 'Close chat'}
      >
        {step === 'closed' ? (
          <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </button>
    </>
  );
}

export default function BranchPicker() {
  return (
    <Suspense fallback={null}>
      <BranchPickerInner />
    </Suspense>
  );
}

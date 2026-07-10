'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import { useLang } from '@/app/i18n/LocaleProvider';

// Meta WhatsApp Embedded Signup (public values — the app id is exposed in every OAuth URL anyway).
const META_APP_ID = '1600229954436428';
const WA_CONFIG_ID = '888785980261763';

interface SocialConnection {
  id: string;
  platform: string;
  isActive: boolean;
  whatsappPhoneNumberId?: string;
  pageId?: string;
  instagramAccountId?: string;
  accountName?: string;
  createdAt: string;
}

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
  </svg>
);

const FacebookIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
  </svg>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
  </svg>
);


export default function IntegrationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const router = useRouter();
  const [connections, setConnections] = useState<SocialConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGarageId, setSelectedGarageId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const lang = useLang();
  const c = {
    en: {
      connectedPlatform: (platform: string) => `Successfully connected ${platform}! You can now receive messages.`,
      failedToConnect: (error: string) => `Failed to connect: ${error}. Please try again or contact support.`,
      waStillLoading: 'WhatsApp connect is still loading — please try again in a moment.',
      waCancelled: 'WhatsApp sign-up was cancelled before it finished.',
      waConnected: (name?: string) => `WhatsApp connected${name ? ` (${name})` : ''}! You can now receive messages.`,
      waConnectFailed: (detail: string) => `WhatsApp connect failed: ${detail}`,
      waConnectFailedRetry: 'WhatsApp connect failed. Please try again or contact support.',
      unknownError: 'unknown error',
      metaSetupSuffix: '\n\nPlease contact hello@receptionmate.co.uk to complete your Meta app setup.',
      failedConnectRetry: 'Failed to connect. Please try again or contact support.',
      confirmDisconnect: 'Are you sure you want to disconnect this platform?',
      failedDisconnect: 'Failed to disconnect platform',
      failedConnectShort: 'Failed to connect. Please try again.',
      loading: 'Loading integrations...',
      backToMessages: 'Back to Messages',
      title: 'Integrations',
      subtitle: 'Connect your social media accounts to manage all customer conversations in one place',
      tabSocial: 'Social media',
      tabWidget: 'Website widget',
      connected: 'Connected',
      since: (date: string) => `since ${date}`,
      disconnect: 'Disconnect',
      setUpNew: 'Set up new',
      connectExisting: 'Connect existing',
      connect: 'Connect',
      needHand: 'Need a hand connecting these?',
      needHandBody: 'Setting up social channels requires Meta Business verification. Our team will walk you through:',
      emailUs: 'Email hello@receptionmate.co.uk',
      platforms: {
        whatsapp: { name: 'WhatsApp Business', description: 'Connect your WhatsApp Business account to send and receive messages' },
        facebook: { name: 'Facebook Messenger', description: 'Connect your Facebook Page to respond to Messenger conversations' },
        instagram: { name: 'Instagram', description: 'Connect your Instagram Business account to manage DMs' },
      } as Record<string, { name: string; description: string }>,
      steps: [
        'Creating or connecting your Meta Business Account',
        'Verifying your WhatsApp Business number',
        'Setting up the webhook configurations',
        'Configuring message templates and permissions',
      ],
    },
    fr: {
      connectedPlatform: (platform: string) => `${platform} connecté avec succès ! Vous pouvez désormais recevoir des messages.`,
      failedToConnect: (error: string) => `Échec de la connexion : ${error}. Veuillez réessayer ou contacter le support.`,
      waStillLoading: 'La connexion WhatsApp est en cours de chargement — veuillez réessayer dans un instant.',
      waCancelled: "L'inscription WhatsApp a été annulée avant la fin.",
      waConnected: (name?: string) => `WhatsApp connecté${name ? ` (${name})` : ''} ! Vous pouvez désormais recevoir des messages.`,
      waConnectFailed: (detail: string) => `Échec de la connexion WhatsApp : ${detail}`,
      waConnectFailedRetry: 'Échec de la connexion WhatsApp. Veuillez réessayer ou contacter le support.',
      unknownError: 'erreur inconnue',
      metaSetupSuffix: '\n\nVeuillez contacter hello@receptionmate.co.uk pour finaliser la configuration de votre application Meta.',
      failedConnectRetry: 'Échec de la connexion. Veuillez réessayer ou contacter le support.',
      confirmDisconnect: 'Voulez-vous vraiment déconnecter cette plateforme ?',
      failedDisconnect: 'Échec de la déconnexion de la plateforme',
      failedConnectShort: 'Échec de la connexion. Veuillez réessayer.',
      loading: 'Chargement des intégrations...',
      backToMessages: 'Retour aux messages',
      title: 'Intégrations',
      subtitle: 'Connectez vos comptes de réseaux sociaux pour gérer toutes les conversations clients au même endroit',
      tabSocial: 'Réseaux sociaux',
      tabWidget: 'Widget de site web',
      connected: 'Connecté',
      since: (date: string) => `depuis le ${date}`,
      disconnect: 'Déconnecter',
      setUpNew: 'Configurer un nouveau',
      connectExisting: 'Connecter un compte existant',
      connect: 'Connecter',
      needHand: "Besoin d'aide pour les connecter ?",
      needHandBody: "La configuration des canaux sociaux nécessite la vérification Meta Business. Notre équipe vous guidera à travers :",
      emailUs: 'Écrire à hello@receptionmate.co.uk',
      platforms: {
        whatsapp: { name: 'WhatsApp Business', description: 'Connectez votre compte WhatsApp Business pour envoyer et recevoir des messages' },
        facebook: { name: 'Facebook Messenger', description: 'Connectez votre Page Facebook pour répondre aux conversations Messenger' },
        instagram: { name: 'Instagram', description: 'Connectez votre compte Instagram Business pour gérer les messages privés' },
      } as Record<string, { name: string; description: string }>,
      steps: [
        'La création ou la connexion de votre compte Meta Business',
        'La vérification de votre numéro WhatsApp Business',
        'La configuration des webhooks',
        'La configuration des modèles de messages et des autorisations',
      ],
    },
  }[lang];


  useEffect(() => {
    const garageId = getGarageId();
    const token = getSessionToken();
    if (!garageId || !token) {
      router.push('/login');
      return;
    }
    setSelectedGarageId(garageId);

    // Check for OAuth callback status
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const error = params.get('error');
    const platform = params.get('platform');

    if (success === 'true' && platform) {
      setStatusMessage({
        type: 'success',
        text: c.connectedPlatform(platform)
      });
      // Clean URL
      window.history.replaceState({}, '', '/integrations');
    } else if (error) {
      setStatusMessage({
        type: 'error',
        text: c.failedToConnect(error)
      });
      // Clean URL
      window.history.replaceState({}, '', '/integrations');
    }
  }, [router]);

  useEffect(() => {
    if (selectedGarageId) {
      fetchConnections();
    }
  }, [selectedGarageId]);

  // Load the Facebook JS SDK for WhatsApp Embedded Signup (lets garages create a WABA inline).
  useEffect(() => {
    if (document.getElementById('facebook-jssdk')) return;
    (window as any).fbAsyncInit = function () {
      (window as any).FB?.init({ appId: META_APP_ID, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
    };
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    document.body.appendChild(script);
  }, []);

  const fetchConnections = async () => {
    if (!selectedGarageId) return;

    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${selectedGarageId}/social-connections`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch connections');

      const data = await response.json();
      setConnections(data.connections || []);
    } catch (error) {
      console.error('Error fetching connections:', error);
    } finally {
      setLoading(false);
    }
  };

  // WhatsApp uses Meta Embedded Signup (JS SDK popup) instead of the redirect OAuth, so garages
  // without a WhatsApp Business account can create one inline. FB.login returns an auth code; the
  // WA_EMBEDDED_SIGNUP message event carries the new WABA id + phone number id.
  const connectWhatsAppEmbedded = () => {
    if (!selectedGarageId) return;
    const FB = (window as any).FB;
    if (!FB) {
      setStatusMessage({ type: 'error', text: c.waStillLoading });
      return;
    }

    const signup: { wabaId?: string; phoneNumberId?: string } = {};
    const onMessage = (event: MessageEvent) => {
      if (!event.origin.includes('facebook.com')) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type === 'WA_EMBEDDED_SIGNUP' && data?.event === 'FINISH') {
          signup.wabaId = data.data?.waba_id;
          signup.phoneNumberId = data.data?.phone_number_id;
        }
      } catch { /* ignore non-JSON postMessages */ }
    };
    window.addEventListener('message', onMessage);

    FB.login(
      (response: any) => {
        window.removeEventListener('message', onMessage);
        const code = response?.authResponse?.code;
        if (!code) {
          setStatusMessage({ type: 'error', text: c.waCancelled });
          return;
        }
        finishWhatsAppSignup(code, signup.wabaId, signup.phoneNumberId);
      },
      {
        config_id: WA_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { feature: 'whatsapp_embedded_signup', setup: {}, sessionInfoVersion: '3' },
      }
    );
  };

  const finishWhatsAppSignup = async (code: string, wabaId?: string, phoneNumberId?: string) => {
    try {
      const token = getSessionToken();
      const pageUrl = window.location.origin + window.location.pathname;
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/oauth/whatsapp/embedded-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code, wabaId, phoneNumberId, garageId: selectedGarageId, configId: WA_CONFIG_ID, pageUrl }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage({ type: 'success', text: c.waConnected(data.accountName) });
        fetchConnections();
      } else {
        setStatusMessage({ type: 'error', text: c.waConnectFailed(data.error || data.detail || c.unknownError) });
      }
    } catch {
      setStatusMessage({ type: 'error', text: c.waConnectFailedRetry });
    }
  };

  const connectPlatform = async (platformId: string) => {
    if (!selectedGarageId) return;

    // WhatsApp → Embedded Signup popup; Facebook/Instagram → redirect OAuth.
    if (platformId === 'whatsapp') {
      connectWhatsAppEmbedded();
      return;
    }

    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/oauth/meta/initiate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            platform: platformId,
            garageId: selectedGarageId,
          }),
        }
      );

      const data = await response.json();

      if (data.authUrl) {
        // Redirect to Meta OAuth
        window.location.href = data.authUrl;
      } else if (data.message) {
        // Show setup message if Meta app not configured yet
        alert(data.message + c.metaSetupSuffix);
      }
    } catch (error) {
      console.error('Error initiating OAuth:', error);
      alert(c.failedConnectRetry);
    }
  };


  const disconnectPlatform = async (connectionId: string) => {
    if (!confirm(c.confirmDisconnect)) return;

    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/social-connections/${connectionId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to disconnect');

      await fetchConnections();
    } catch (error) {
      console.error('Error disconnecting:', error);
      alert(c.failedDisconnect);
    }
  };

  const platforms = [
    {
      id: 'whatsapp',
      name: 'WhatsApp Business',
      icon: WhatsAppIcon,
      color: 'bg-green-600',
      description: 'Connect your WhatsApp Business account to send and receive messages',
    },
    {
      id: 'facebook',
      name: 'Facebook Messenger',
      icon: FacebookIcon,
      color: 'bg-blue-600',
      description: 'Connect your Facebook Page to respond to Messenger conversations',
    },
    {
      id: 'instagram',
      name: 'Instagram',
      icon: InstagramIcon,
      color: 'bg-purple-600',
      description: 'Connect your Instagram Business account to manage DMs',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-slate-500">{c.loading}</div>
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'max-w-4xl mx-auto'}>
      <div className="mb-6">
        {!embedded && (
          <>
            <button
              onClick={() => router.push('/messages')}
              className="flex items-center gap-2 text-slate-500 hover:text-slate-900 transition-colors mb-4"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-sm">{c.backToMessages}</span>
            </button>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">{c.title}</h1>
            <p className="text-slate-500">
              {c.subtitle}
            </p>
          </>
        )}

        {/* Tab switcher */}
        <div className="flex gap-1 mt-5 p-1 bg-slate-100 rounded-lg w-fit">
          <button
            className="px-4 py-1.5 text-sm font-semibold rounded-md bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
            aria-current="page"
          >
            {c.tabSocial}
          </button>
          <button
            onClick={() => router.push('/integrations/widget')}
            className="px-4 py-1.5 text-sm font-medium rounded-md text-slate-600 hover:text-slate-900 transition-colors"
          >
            {c.tabWidget}
          </button>
        </div>

        {/* Status Message */}
        {statusMessage && (
          <div className={cn(
            'mt-4 p-4 rounded-lg border',
            statusMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          )}>
            <div className="flex items-center gap-2">
              {statusMessage.type === 'success' ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              <span className="text-sm font-medium">{statusMessage.text}</span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {platforms.map((platform) => {
          const connection = connections.find((conn) => conn.platform === platform.id);
          const Icon = platform.icon;
          const pt = c.platforms[platform.id];

          return (
            <div
              key={platform.id}
              className="bg-white border border-slate-200 rounded-lg p-6"
            >
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className={cn('p-3 rounded-lg', platform.color)}>
                    <Icon />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">
                      {pt?.name ?? platform.name}
                    </h3>
                    <p className="text-sm text-slate-500 mb-3">{pt?.description ?? platform.description}</p>

                    {connection && (
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                          {c.connected}
                        </span>
                        {connection.accountName && (
                          <span className="text-slate-700 font-medium">{connection.accountName}</span>
                        )}
                        <span className="text-slate-300">·</span>
                        <span className="text-slate-500">
                          {c.since(new Date(connection.createdAt).toLocaleDateString())}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="ml-14 md:ml-4 shrink-0">
                  {connection ? (
                    <button
                      onClick={() => disconnectPlatform(connection.id)}
                      className="px-4 py-2 text-sm border border-slate-300 bg-white hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 text-slate-700 rounded-md transition-colors"
                    >
                      {c.disconnect}
                    </button>
                  ) : platform.id === 'whatsapp' ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => connectWhatsAppEmbedded()}
                        className={cn(
                          'px-3 py-2 text-sm text-white rounded-md transition-colors shadow-sm',
                          platform.color,
                          'hover:opacity-90'
                        )}
                      >
                        {c.setUpNew}
                      </button>
                      <button
                        onClick={() => {
                          const token = getSessionToken();
                          fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/oauth/meta/initiate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                            body: JSON.stringify({ platform: 'whatsapp', garageId: selectedGarageId }),
                          })
                            .then(r => r.json())
                            .then(data => { if (data.authUrl) window.location.href = data.authUrl; })
                            .catch(() => alert(c.failedConnectShort));
                        }}
                        className="px-3 py-2 text-sm text-slate-700 bg-white hover:bg-slate-50 rounded-md transition-colors border border-slate-300 shadow-sm"
                      >
                        {c.connectExisting}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => connectPlatform(platform.id)}
                      className={cn(
                        'px-4 py-2 text-sm text-white rounded-md transition-colors shadow-sm',
                        platform.color,
                        'hover:opacity-90'
                      )}
                    >
                      {c.connect}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 rounded-2xl border border-brand-200 bg-brand-50/60 p-6">
        <div className="flex items-start gap-4">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-brand-600 ring-1 ring-brand-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-slate-900">{c.needHand}</h3>
            <p className="mt-1 text-sm text-slate-700">
              {c.needHandBody}
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
              {c.steps.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <a
              href="mailto:hello@receptionmate.co.uk?subject=Social%20media%20integration%20setup"
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:bg-brand-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              {c.emailUs}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

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


export default function IntegrationsPage() {
  const router = useRouter();
  const [connections, setConnections] = useState<SocialConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGarageId, setSelectedGarageId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);


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
        text: `Successfully connected ${platform}! You can now receive messages.`
      });
      // Clean URL
      window.history.replaceState({}, '', '/integrations');
    } else if (error) {
      setStatusMessage({
        type: 'error',
        text: `Failed to connect: ${error}. Please try again or contact support.`
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

  const connectPlatform = async (platformId: string) => {
    if (!selectedGarageId) return;

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
        alert(data.message + '\n\nPlease contact support@receptionmate.com to complete your Meta app setup.');
      }
    } catch (error) {
      console.error('Error initiating OAuth:', error);
      alert('Failed to connect. Please try again or contact support.');
    }
  };


  const disconnectPlatform = async (connectionId: string) => {
    if (!confirm('Are you sure you want to disconnect this platform?')) return;

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
      alert('Failed to disconnect platform');
    }
  };

  const platforms = [
    {
      id: 'whatsapp',
      name: 'WhatsApp Business',
      icon: WhatsAppIcon,
      color: 'bg-green-600',
      description: 'Connect your WhatsApp Business account to receive and respond to customer messages',
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
        <div className="text-slate-400">Loading integrations...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => router.push('/messages')}
          className="flex items-center gap-2 text-slate-400 hover:text-slate-100 transition-colors mb-4"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="text-sm">Back to Messages</span>
        </button>
        <h1 className="text-2xl font-bold text-slate-100 mb-2">Integrations</h1>
        <p className="text-slate-400">
          Connect your social media accounts to manage all customer conversations in one place
        </p>

        {/* Tab switcher */}
        <div className="flex gap-1 mt-5 p-1 bg-slate-800/60 rounded-lg w-fit border border-slate-700">
          <button
            className="px-4 py-1.5 text-sm font-medium rounded-md bg-slate-700 text-slate-100 shadow-sm"
          >
            Social Media
          </button>
          <button
            onClick={() => router.push('/integrations/widget')}
            className="px-4 py-1.5 text-sm font-medium rounded-md text-slate-400 hover:text-slate-200 transition-colors"
          >
            Website Widget
          </button>
        </div>

        {/* Status Message */}
        {statusMessage && (
          <div className={cn(
            'mt-4 p-4 rounded-lg border',
            statusMessage.type === 'success'
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
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
          const connection = connections.find((c) => c.platform === platform.id);
          const Icon = platform.icon;
          const isWhatsApp = platform.id === 'whatsapp';

          return (
            <div
              key={platform.id}
              className="bg-slate-900/40 border border-slate-800 rounded-lg p-6"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className={cn('p-3 rounded-lg', platform.color)}>
                    <Icon />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-slate-100 mb-1">
                      {platform.name}
                    </h3>
                    <p className="text-sm text-slate-400 mb-3">{platform.description}</p>

                    {connection && (
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2 h-2 rounded-full bg-green-500"></div>
                          <span className="text-green-400">Connected</span>
                        </div>
                        {connection.accountName && (
                          <>
                            <span className="text-slate-600">•</span>
                            <span className="text-slate-300 font-medium">{connection.accountName}</span>
                          </>
                        )}
                        <span className="text-slate-600">•</span>
                        <span className="text-slate-500">
                          Since {new Date(connection.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    )}

                    {/* WhatsApp-specific: show setup options when not connected */}
                    {isWhatsApp && !connection && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-start gap-2 p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                          <svg className="w-4 h-4 text-green-400 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                          <div>
                            <p className="text-sm font-medium text-slate-200">Already have a WhatsApp Business account?</p>
                            <p className="text-xs text-slate-400 mt-0.5">Connect it using the button on the right and we'll link it to your ReceptionMate account.</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-2 p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <div>
                            <p className="text-sm font-medium text-slate-200">Don't have one yet?</p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              You'll need a WhatsApp Business Account through Meta before connecting. Our team can help you set this up —{' '}
                              <a href="mailto:support@receptionmate.com" className="text-purple-400 hover:text-purple-300 underline">contact support</a>.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="ml-4 shrink-0">
                  {connection ? (
                    <button
                      onClick={() => disconnectPlatform(connection.id)}
                      className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-md transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => connectPlatform(platform.id)}
                      className={cn(
                        'px-4 py-2 text-sm text-white rounded-md transition-colors',
                        platform.color,
                        'hover:opacity-90'
                      )}
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 bg-slate-900/40 border border-slate-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-slate-100 mb-2">Setting up WhatsApp Business</h3>
        <p className="text-sm text-slate-400 mb-4">
          To connect WhatsApp, you need a verified WhatsApp Business Account through Meta. Here's what's involved:
        </p>
        <ul className="space-y-2 text-sm text-slate-400 mb-4">
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5 font-bold">1.</span>
            <span><span className="text-slate-200">Create a Meta Business Account</span> at business.facebook.com (free)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5 font-bold">2.</span>
            <span><span className="text-slate-200">Add a WhatsApp Business number</span> — this can be a new number or your existing business phone</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5 font-bold">3.</span>
            <span><span className="text-slate-200">Verify the number</span> via SMS or phone call from Meta</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5 font-bold">4.</span>
            <span><span className="text-slate-200">Connect to ReceptionMate</span> using the Connect button above</span>
          </li>
        </ul>
        <p className="text-sm text-slate-500 mb-4">Our team can walk you through each step — it typically takes less than 30 minutes.</p>
        <a
          href="mailto:support@receptionmate.com"
          className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-md transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Get Setup Help
        </a>
      </div>
    </div>
  );
}

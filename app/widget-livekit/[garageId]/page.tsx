'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Room, RoomEvent, Track } from 'livekit-client';
import { RoomAudioRenderer, RoomContext, StartAudio, useLocalParticipant, useTracks } from '@livekit/components-react';

interface WidgetConfig {
  id: string;
  name: string;
  agentName?: string;
  primaryColor?: string;
  whatsappNumber?: string;
  phone?: string;
}

interface ConnectionDetails {
  serverUrl: string;
  participantToken: string;
}

export default function LiveKitWidgetPage() {
  const params = useParams();
  const garageId = params.garageId as string;
  
  const [viewState, setViewState] = useState<'closed' | 'menu' | 'chat'>('closed');
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  
  const room = useMemo(() => new Room(), []);

  // Fetch widget config
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch(`/api/widget/${garageId}`);
        if (response.ok) {
          const data = await response.json();
          setConfig(data);
        } else {
          console.error('Failed to fetch widget config, using fallback');
          // Fallback config for demo
          setConfig({
            id: garageId,
            name: 'Demo Garage',
            agentName: 'Leah',
            phone: '+447123456789',
            whatsappNumber: '447123456789',
            primaryColor: '#2C50EF'
          });
        }
      } catch (error) {
        console.error('Failed to fetch widget config, using fallback:', error);
        // Fallback config for demo
        setConfig({
          id: garageId,
          name: 'Demo Garage',
          agentName: 'Leah',
          phone: '+447123456789',
          whatsappNumber: '447123456789',
          primaryColor: '#2C50EF'
        });
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, [garageId]);

  // Fetch LiveKit connection details
  useEffect(() => {
    const fetchConnectionDetails = async () => {
      try {
        const response = await fetch('/api/livekit/connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ garageId }),
        });
        if (response.ok) {
          const data = await response.json();
          setConnectionDetails(data);
        }
      } catch (error) {
        console.error('Failed to fetch connection details:', error);
      }
    };
    fetchConnectionDetails();
  }, [garageId]);

  // Connect to LiveKit room when session starts
  useEffect(() => {
    if (!sessionStarted || !connectionDetails) return;

    const connect = async () => {
      try {
        await room.connect(connectionDetails.serverUrl, connectionDetails.participantToken);
        await room.localParticipant.setMicrophoneEnabled(true);
        console.log('Connected to LiveKit room');
      } catch (error) {
        console.error('Error connecting to agent:', error);
      }
    };
    
    connect();

    return () => {
      room.disconnect();
    };
  }, [room, sessionStarted, connectionDetails]);

  // Handle room events
  useEffect(() => {
    const onDisconnected = () => {
      setSessionStarted(false);
    };
    
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  const handleStartVoiceCall = () => {
    setViewState('chat');
    setSessionStarted(true);
  };

  const handleWhatsApp = () => {
    if (config?.whatsappNumber) {
      window.open(`https://wa.me/${config.whatsappNumber}`, '_blank');
    }
  };

  const handleVoiceCall = () => {
    if (config?.phone) {
      window.location.href = `tel:${config.phone}`;
    }
  };

  if (loading || !config) {
    return null;
  }

  return (
    <>
      {/* Voice Chat Window */}
      {viewState === 'chat' && (
        <div className="fixed bottom-6 right-6 z-50 w-[400px] max-w-[calc(100vw-48px)] h-[600px] max-h-[calc(100vh-48px)] flex flex-col animate-in slide-in-from-bottom-4 duration-200 rounded-2xl shadow-2xl overflow-hidden" style={{ backgroundColor: '#F5F5F7' }}>
          {/* Header */}
          <div className="px-6 py-4 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <div>
                <h3 className="text-white font-medium text-base">
                  {sessionStarted ? 'Connected' : 'Starting...'}
                </h3>
              </div>
            </div>
            <button
              onClick={() => {
                setViewState('closed');
                setSessionStarted(false);
                room.disconnect();
              }}
              className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Voice Session View */}
          <div className="flex-1 flex flex-col items-center justify-center bg-white p-6">
            <RoomContext.Provider value={room}>
              <RoomAudioRenderer />
              <StartAudio label="Click to enable audio" />
              
              <VoiceSessionContent sessionStarted={sessionStarted} />
            </RoomContext.Provider>
          </div>

          {/* Controls */}
          <div className="border-t border-gray-200 px-6 py-4 bg-white flex-shrink-0">
            <div className="flex gap-3 items-center justify-center">
              <button
                onClick={() => {
                  setSessionStarted(false);
                  room.disconnect();
                }}
                disabled={!sessionStarted}
                className="px-6 py-3 rounded-full bg-red-500 text-white font-medium disabled:opacity-40 transition-all hover:bg-red-600 active:scale-95 disabled:hover:bg-red-500"
              >
                End Call
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Menu State */}
      {viewState === 'menu' && (
        <div className="fixed bottom-6 right-6 z-50 w-[340px] max-w-[calc(100vw-48px)] animate-in slide-in-from-bottom-4 duration-200 rounded-2xl shadow-2xl overflow-hidden bg-white">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-gray-800">Message us on...</h3>
              <button
                onClick={() => setViewState('closed')}
                className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors"
              >
                <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="space-y-3">
              {/* WhatsApp Button */}
              {config.whatsappNumber && (
                <button
                  onClick={handleWhatsApp}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-green-500 hover:shadow-sm"
                >
                  <div className="w-11 h-11 bg-green-500 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-semibold text-gray-900">WhatsApp</div>
                    <div className="text-xs text-gray-500">Message on WhatsApp</div>
                  </div>
                </button>
              )}

              {/* Voice Call Button */}
              <button
                onClick={handleStartVoiceCall}
                className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-blue-500 hover:shadow-sm"
              >
                <div className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <div className="text-left flex-1">
                  <div className="font-semibold text-gray-900">Voice Chat</div>
                  <div className="text-xs text-gray-500">Talk to our AI assistant</div>
                </div>
              </button>

              {/* Phone Button */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-purple-500 hover:shadow-sm"
                >
                  <div className="w-11 h-11 bg-purple-500 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-semibold text-gray-900">Phone Call</div>
                    <div className="text-xs text-gray-500">Call {config.phone}</div>
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Button */}
      <button
        onClick={() => setViewState(viewState === 'closed' ? 'menu' : 'closed')}
        className="fixed bottom-6 right-6 z-50 w-16 h-16 rounded-full shadow-2xl hover:shadow-3xl flex items-center justify-center transition-all duration-300 hover:scale-105 active:scale-95"
        style={{ 
          background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)',
          boxShadow: '0 8px 24px rgba(75, 118, 230, 0.4)'
        }}
        aria-label={viewState === 'closed' ? 'Open chat' : 'Close chat'}
      >
        {viewState === 'closed' ? (
          <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
    </>
  );
}

// Component to display voice session content
function VoiceSessionContent({ sessionStarted }: { sessionStarted: boolean }) {
  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks([Track.Source.Microphone]);

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Audio Visualizer */}
      <div className="w-32 h-32 rounded-full flex items-center justify-center" 
           style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
        <svg className="w-16 h-16 text-white animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
      </div>

      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {sessionStarted ? 'Voice Chat Active' : 'Connecting...'}
        </h3>
        <p className="text-sm text-gray-500">
          {sessionStarted ? 'Speak naturally to our AI assistant' : 'Please wait...'}
        </p>
      </div>

      {/* Mic Status */}
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <div className={`w-3 h-3 rounded-full ${localParticipant.isMicrophoneEnabled ? 'bg-green-500' : 'bg-red-500'}`} />
        <span>{localParticipant.isMicrophoneEnabled ? 'Microphone On' : 'Microphone Off'}</span>
      </div>
    </div>
  );
}

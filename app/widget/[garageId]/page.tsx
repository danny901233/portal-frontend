'use client';

import { useState, useEffect } from 'react';

interface GarageConfig {
  name: string;
  phone?: string;
  whatsappNumber?: string;
  primaryColor?: string;
}

export default function ChatWidget({ params }: { params: { garageId: string } }) {
  const [isOpen, setIsOpen] = useState(false);
  const [config, setConfig] = useState<GarageConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch garage configuration
    fetch(`https://api.receptionmate.co.uk/api/widget/${params.garageId}`)
      .then((res) => res.json())
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load widget config:', err);
        setLoading(false);
      });
  }, [params.garageId]);

  const handleWebChat = () => {
    // Open the agent call interface in a new window
    window.open(
      `https://portal.receptionmate.co.uk/calls/new?garageId=${params.garageId}&source=widget`,
      '_blank',
      'width=400,height=600'
    );
  };

  const handleVoiceCall = () => {
    if (config?.phone) {
      window.location.href = `tel:${config.phone}`;
    }
  };

  const handleWhatsApp = () => {
    if (config?.whatsappNumber) {
      const message = encodeURIComponent('Hi, I would like to get in touch.');
      window.open(`https://wa.me/${config.whatsappNumber}?text=${message}`, '_blank');
    }
  };

  if (loading) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <div className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center animate-pulse">
          <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        </div>
      </div>
    );
  }

  if (!config) {
    return null;
  }

  const primaryColor = config.primaryColor || '#2563eb';

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsOpen(false)}
          style={{ background: 'transparent' }}
        />
      )}

      {/* Widget Container */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {/* Options Menu */}
        {isOpen && (
          <div
            className="bg-white rounded-2xl shadow-2xl p-6 w-80 animate-in slide-in-from-bottom-4 duration-300"
            style={{ borderTop: `4px solid ${primaryColor}` }}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Message us on...</h3>
            
            <div className="space-y-3">
              {/* WhatsApp Option */}
              {config.whatsappNumber && (
                <button
                  onClick={handleWhatsApp}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-green-500 hover:bg-green-50 transition-all duration-200"
                >
                  <svg className="w-8 h-8 text-green-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  <span className="text-lg font-medium text-gray-900">WhatsApp</span>
                </button>
              )}

              {/* Web Chat Option */}
              <button
                onClick={handleWebChat}
                className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:bg-blue-50 transition-all duration-200"
                style={{ 
                  borderColor: isOpen ? primaryColor : undefined,
                  backgroundColor: isOpen ? `${primaryColor}10` : undefined 
                }}
              >
                <svg className="w-8 h-8" style={{ color: primaryColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <span className="text-lg font-medium text-gray-900">Web Chat</span>
              </button>

              {/* Voice Call Option */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-all duration-200"
                >
                  <svg className="w-8 h-8 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span className="text-lg font-medium text-gray-900">Voice Call</span>
                </button>
              )}
            </div>

            <div className="mt-4 text-center text-sm text-gray-500">
              Powered by ReceptionMate
            </div>
          </div>
        )}

        {/* Main Chat Button */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-16 h-16 rounded-full shadow-2xl flex items-center justify-center transition-transform duration-300 hover:scale-110"
          style={{ backgroundColor: primaryColor }}
          aria-label={isOpen ? 'Close chat' : 'Open chat'}
        >
          {isOpen ? (
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}


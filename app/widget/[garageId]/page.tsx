'use client';

import { useState, useEffect } from 'react';
import { MessageCircle, Phone, X } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';

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
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/widget/${params.garageId}`)
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
          <MessageCircle className="w-7 h-7 text-white" />
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
                  <FaWhatsapp className="w-8 h-8 text-green-500" />
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
                <MessageCircle className="w-8 h-8" style={{ color: primaryColor }} />
                <span className="text-lg font-medium text-gray-900">Web Chat</span>
              </button>

              {/* Voice Call Option */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-all duration-200"
                >
                  <Phone className="w-8 h-8 text-purple-500" />
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
            <X className="w-8 h-8 text-white" />
          ) : (
            <MessageCircle className="w-8 h-8 text-white" />
          )}
        </button>
      </div>
    </>
  );
}

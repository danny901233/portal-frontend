'use client';

import { useState, useEffect } from 'react';

export default function WidgetEmbedPage() {
  const [copied, setCopied] = useState(false);
  const [garageId, setGarageId] = useState<string>('');
  const [garageName, setGarageName] = useState<string>('');

  useEffect(() => {
    // Get garage info from localStorage or API
    const storedGarageId = localStorage.getItem('selectedGarageId');
    const storedGarageName = localStorage.getItem('selectedGarageName') || 'Your Garage';
    
    if (storedGarageId) {
      setGarageId(storedGarageId);
      setGarageName(storedGarageName);
    }
  }, []);

  const embedCode = garageId
    ? `<!-- ReceptionMate Chat Widget -->
<iframe 
  src="https://portal.receptionmate.co.uk/widget/${garageId}" 
  style="position: fixed; bottom: 0; right: 0; width: 100%; height: 100%; border: none; pointer-events: none; z-index: 999999;"
  allow="microphone"
  id="receptionmate-widget"
></iframe>
<script>
  // Make only the widget clickable
  document.getElementById('receptionmate-widget').contentWindow.document.body.style.pointerEvents = 'auto';
</script>`
    : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePreview = () => {
    window.open(`/widget/${garageId}`, '_blank');
  };

  if (!garageId) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Website Chat Widget</h1>
            <p className="text-gray-600">
              Add a chat widget to your website to let customers reach you via WhatsApp, Web Chat, or Voice Call.
            </p>
          </div>

          {/* Preview Section */}
          <div className="mb-8 bg-blue-50 border-2 border-blue-200 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Preview</h2>
              <button
                onClick={handlePreview}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open Preview
              </button>
            </div>
            <p className="text-sm text-gray-600">
              Click "Open Preview" to see how the widget will look on your website.
            </p>
          </div>

          {/* Embed Code Section */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Embed Code</h2>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Copied!
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    Copy Code
                  </>
                )}
              </button>
            </div>
            <div className="bg-gray-900 rounded-lg p-6 overflow-x-auto">
              <pre className="text-sm text-green-400 font-mono">
                <code>{embedCode}</code>
              </pre>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-gray-50 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">How to Install</h2>
            <ol className="space-y-3 text-gray-700">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-semibold">
                  1
                </span>
                <span>Copy the embed code above by clicking "Copy Code"</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-semibold">
                  2
                </span>
                <span>
                  Paste the code into your website's HTML, just before the closing{' '}
                  <code className="bg-gray-200 px-2 py-1 rounded text-sm">&lt;/body&gt;</code> tag
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-semibold">
                  3
                </span>
                <span>Save and publish your website - the chat widget will appear in the bottom right corner</span>
              </li>
            </ol>
          </div>

          {/* Garage Info */}
          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <p className="text-sm text-gray-600">
              <strong>Garage:</strong> {garageName}
            </p>
            <p className="text-sm text-gray-600 mt-1">
              <strong>Widget ID:</strong> <code className="bg-white px-2 py-1 rounded">{garageId}</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

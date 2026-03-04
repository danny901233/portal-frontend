'use client';

export default function WidgetDemo() {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-8">
      <div className="max-w-4xl w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">ReceptionMate Widget Demo</h1>
        <p className="text-gray-600 mb-8">
          Test the chat widgets below. Look for the floating button in the bottom right corner.
        </p>

        <div className="grid md:grid-cols-2 gap-8 mb-8">
          <div className="border rounded-lg p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-3">💬 Text Chat Widget</h2>
            <p className="text-gray-600 mb-4">
              AI-powered text chat for customer inquiries and bookings.
            </p>
            <ul className="text-sm text-gray-500 space-y-2 mb-4">
              <li>✓ Natural conversation</li>
              <li>✓ Vehicle booking</li>
              <li>✓ Service selection</li>
              <li>✓ WhatsApp & Phone options</li>
            </ul>
            <a
              href="/widget/d51dfa55-15d0-4d60-ad81-c675579d16f6"
              target="_blank"
              className="block w-full text-center px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              Open Text Chat
            </a>
          </div>

          <div className="border rounded-lg p-6 bg-gradient-to-br from-blue-50 to-purple-50">
            <h2 className="text-xl font-semibold text-gray-900 mb-3">🎤 Voice Chat Widget</h2>
            <p className="text-gray-600 mb-4">
              Real-time voice chat with your AI receptionist.
            </p>
            <ul className="text-sm text-gray-500 space-y-2 mb-4">
              <li>✓ Real-time voice conversation</li>
              <li>✓ HD WebRTC audio</li>
              <li>✓ Uses your trained agent</li>
              <li>✓ Natural spoken interaction</li>
            </ul>
            <a
              href="/widget-livekit/d51dfa55-15d0-4d60-ad81-c675579d16f6"
              target="_blank"
              className="block w-full text-center px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-500 text-white rounded-lg hover:from-blue-600 hover:to-purple-600 transition-all"
            >
              Open Voice Chat
            </a>
          </div>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-8">
          <h3 className="font-semibold text-yellow-900 mb-2">⚠️ Demo Mode</h3>
          <p className="text-yellow-800 text-sm">
            The widgets are running in demo mode with fallback configurations. For full functionality:
          </p>
          <ul className="text-yellow-800 text-sm mt-2 space-y-1 list-disc list-inside">
            <li>Start the backend: <code className="bg-yellow-100 px-2 py-1 rounded">cd backend && npm run dev</code></li>
            <li>Start the agent: <code className="bg-yellow-100 px-2 py-1 rounded">cd agent-v3 && python Newreceptionmateagent.py dev</code></li>
          </ul>
        </div>

        <div className="border-t pt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">How to Test:</h3>
          
          <div className="space-y-4">
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Text Chat Widget:</h4>
              <ol className="text-gray-600 text-sm space-y-1 list-decimal list-inside">
                <li>Click "Open Text Chat" button above</li>
                <li>Click the blue floating button (bottom right)</li>
                <li>Select "Live Chat" from menu</li>
                <li>Type messages to chat with the AI</li>
              </ol>
            </div>

            <div>
              <h4 className="font-medium text-gray-900 mb-2">Voice Chat Widget:</h4>
              <ol className="text-gray-600 text-sm space-y-1 list-decimal list-inside">
                <li>Click "Open Voice Chat" button above</li>
                <li>Click the blue floating button (bottom right)</li>
                <li>Select "Voice Chat" from menu</li>
                <li>Allow microphone access when prompted</li>
                <li>Speak naturally - the AI will respond</li>
              </ol>
              <p className="text-gray-500 text-xs mt-2">
                Note: Voice chat requires your agent (Newreceptionmateagent.py) to be running.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Embed on Your Website:</h3>
          <div className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
            <code className="text-sm">
              {`<!-- Text Chat Widget -->\n<script src="https://portal.receptionmate.co.uk/widget/YOUR_GARAGE_ID"></script>\n\n<!-- Voice Chat Widget -->\n<script src="https://portal.receptionmate.co.uk/widget-voice/YOUR_GARAGE_ID"></script>`}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

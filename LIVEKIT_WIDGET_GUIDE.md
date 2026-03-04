# LiveKit Widget Integration

## Overview
Your widget now supports **Voice Chat** using LiveKit, in addition to the existing text chat functionality.

## Two Widget Options

### 1. **Text Chat Widget** (existing)
- Location: `/widget/[garageId]`
- Features: Text-based chat with chatAgentV2.ts backend
- Example: http://localhost:3000/widget/d51dfa55-15d0-4d60-ad81-c675579d16f6

### 2. **LiveKit Voice Widget** (NEW)
- Location: `/widget-livekit/[garageId]`
- Features: Voice chat with your existing Newreceptionmateagent.py
- Example: http://localhost:3000/widget-livekit/d51dfa55-15d0-4d60-ad81-c675579d16f6

## How It Works

### Voice Chat Flow:
1. User clicks floating button → Opens menu
2. User clicks "Voice Chat" → Connects to LiveKit
3. Widget calls `/api/livekit/connection` to get auth token
4. LiveKit Room connects to `wss://gab-garagehive-o6zj23d5.livekit.cloud`
5. **Your existing `Newreceptionmateagent.py` joins the room automatically**
6. User speaks → Agent responds with voice

### Backend Integration:
Your `Newreceptionmateagent.py` already:
- ✅ Connects to LiveKit rooms
- ✅ Handles voice conversations
- ✅ Uses state machine for bookings
- ✅ Calls GarageHive API

**No changes needed to your agent!** It will automatically join rooms created by the widget.

## Configuration

### Environment Variables (.env.local):
```env
LIVEKIT_URL=wss://gab-garagehive-o6zj23d5.livekit.cloud
LIVEKIT_API_KEY=APIvpD8jbZXE8gn
LIVEKIT_API_SECRET=EbzpHHI8qwy6wXVl8bfeIsKob9DMWsIRMUQG2hY9quj
NEXT_PUBLIC_CONN_DETAILS_ENDPOINT=http://localhost:3000/api/livekit/connection
```

## Testing

### Test Voice Widget:
1. Start dev server: `npm run dev`
2. Visit: http://localhost:3000/widget-livekit/d51dfa55-15d0-4d60-ad81-c675579d16f6
3. Click the blue microphone button
4. Click "Voice Chat"
5. Allow microphone access
6. Start speaking!

### Running Your Agent:
Make sure your agent is running to handle calls:
```bash
cd agent-v3
python Newreceptionmateagent.py dev
```

## Menu Options

Both widgets include:
1. **WhatsApp** - Opens WhatsApp chat (if configured)
2. **Voice Chat** - Starts LiveKit voice session (NEW)
3. **Phone Call** - Calls phone number (if configured)

## Widget Styling

The LiveKit widget matches your existing design:
- Gradient blue header: `linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)`
- Circular floating button (w-16 h-16)
- Microphone icon for voice
- Smooth animations and transitions
- Responsive mobile design

## Production Deployment

### Requirements:
1. Deploy frontend with LiveKit widget
2. Deploy `Newreceptionmateagent.py` to handle rooms
3. Set production environment variables

### Agent Deployment:
Your agent needs to run continuously to join rooms:
```bash
# On EC2 or production server
cd agent-v3
python Newreceptionmateagent.py start
```

### LiveKit Cloud:
- Already configured: `gab-garagehive-o6zj23d5.livekit.cloud`
- API keys already in .env.local
- Production ready!

## Next Steps

### Option A: Replace Text Chat
Replace `/widget/[garageId]` with LiveKit version:
- Provides unified voice experience
- Uses your existing voice agent
- No separate chat backend needed

### Option B: Keep Both
Offer customers choice:
- Text chat for quick questions
- Voice chat for detailed conversations
- WhatsApp for messaging
- Phone for urgent matters

## Troubleshooting

### Widget doesn't connect:
- Check agent is running: `python Newreceptionmateagent.py dev`
- Verify LiveKit credentials in .env.local
- Check browser console for errors

### Microphone not working:
- Browser must have microphone permissions
- Works only on HTTPS in production (localhost OK for dev)
- Check browser compatibility (Chrome/Firefox/Safari supported)

### Agent doesn't respond:
- Ensure agent is subscribed to the correct LiveKit project
- Check agent logs for connection issues
- Verify room names match between widget and agent

## Benefits of LiveKit Approach

✅ **Unified Experience** - Same agent handles both phone and web calls
✅ **Better Quality** - WebRTC audio (not phone quality)
✅ **Cost Effective** - No Twilio minutes for web calls
✅ **Rich Features** - Can add video, screen sharing, chat transcripts
✅ **Already Built** - Your agent is ready, no rewrite needed!

## Comparison

| Feature | Text Chat Widget | LiveKit Voice Widget |
|---------|-----------------|---------------------|
| Backend | chatAgentV2.ts (Node) | Newreceptionmateagent.py (Python) |
| Communication | Text messages | Voice (WebRTC) |
| Experience | Chat bubbles | Natural conversation |
| Agent Reuse | New backend needed | Existing agent works |
| Quality | N/A | HD audio |
| Booking Flow | Implemented | Fully tested in production |

## Recommendation

**Use LiveKit Voice Widget** because:
1. Leverages your existing production-ready voice agent
2. Provides natural conversation experience
3. No need to maintain separate chat backend
4. Same booking flow as phone calls
5. Better customer experience than text chat

The text chat can remain as a fallback option for users who prefer typing.

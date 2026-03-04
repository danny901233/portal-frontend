# Emotion Detection Integration Guide

## Overview
This guide shows how to add emotion detection to your LiveKit AI agent to detect frustrated or angry callers and adjust responses accordingly.

## How It Works

### 1. **Emotion Detection**
The agent analyzes caller's words for emotional keywords:
- **Frustration keywords**: "frustrated", "annoyed", "ridiculous", "waste of time", etc.
- **Anger keywords**: "angry", "furious", "complaint", "manager", "sue", etc.

### 2. **Emotion Scoring**
- Score 0.0-0.5: Calm
- Score 0.5-0.8: Frustrated (adjusts tone)
- Score 0.8-1.0: Angry (considers escalation)

### 3. **Automatic Response Adjustment**
When frustration is detected, the AI:
- Becomes more empathetic
- Speaks slower and calmer
- Acknowledges feelings: "I understand your frustration"
- Avoids defensive language
- Offers concrete solutions

### 4. **Escalation Logic**
Escalates when:
- Anger score > 0.8
- 3+ consecutive frustrated messages
- Caller asks for manager

## Integration Steps

### Option 1: Add to Existing Agent

1. **Copy the EmotionAwareAgent class** from `emotion_detection_agent_example.py`

2. **Add to your existing agent**:
```python
from emotion_detection_agent_example import EmotionAwareAgent

# In your entrypoint function:
emotion_detector = EmotionAwareAgent()

@assistant.on("user_speech_committed")
def on_user_speech(msg):
    asyncio.create_task(handle_emotion(msg))

async def handle_emotion(msg):
    emotion_data = await emotion_detector.process_user_message(
        msg.content, 
        assistant
    )
    
    if emotion_data["score"] >= 0.6:
        # Adjust agent tone
        empathy = emotion_detector.get_empathetic_response_instruction(emotion_data)
        assistant.chat_ctx.messages.append(
            agents.llm.ChatMessage(role="system", content=empathy)
        )
```

### Option 2: Use the Complete Example

Replace your `basic_agent.py` with `emotion_detection_agent_example.py` (rename it first).

## Webhook Integration (Optional)

Send emotion data to your backend when escalation is needed:

```python
import aiohttp

async def notify_backend_of_escalation(call_id: str, emotion_data: dict):
    async with aiohttp.ClientSession() as session:
        await session.post(
            "https://your-backend.com/api/call-escalation",
            json={
                "callId": call_id,
                "emotion": emotion_data["emotion"],
                "score": emotion_data["score"],
                "timestamp": datetime.now().isoformat()
            }
        )
```

## Customization

### Adjust Thresholds
```python
# In emotion_detection_agent_example.py
FRUSTRATION_THRESHOLD = 0.6  # Lower = more sensitive
ANGER_THRESHOLD = 0.8
```

### Add Custom Keywords
```python
frustration_keywords = [
    "frustrated", "annoyed",
    # Add your industry-specific keywords
    "oil change delay", "parts not ready", "overcharged"
]
```

### Custom Empathy Responses
```python
def get_empathetic_response_instruction(self, emotion_data: dict) -> str:
    if emotion == "angry":
        return """
        Say: "I sincerely apologize for this experience. Let me make this right 
        for you immediately. Would you like me to connect you with our service 
        manager?"
        """
```

## Testing

Test with phrases like:
- "This is ridiculous!" → Should detect frustration
- "I'm so frustrated with this" → Should adjust tone
- "I want to speak to a manager!" → Should trigger escalation
- "This is the worst service ever" → High anger detection

## Logging

Check logs for emotion detection:
```bash
# Look for these log messages:
INFO: Emotion detected: {"emotion": "frustrated", "score": 0.7}
WARNING: Frustration detected (score: 0.7) - Adjusting agent tone
ERROR: ESCALATION NEEDED - Customer is very upset
```

## Backend Integration

You can add a new field to your Call model to store emotion data:

```typescript
// In your backend
interface CallMetadata {
  emotionDetected?: {
    maxScore: number;
    emotionChanges: number;
    escalated: boolean;
  }
}
```

Then flag these calls in your dashboard for manager review.

## Next Steps

1. Deploy the updated agent code to your LiveKit worker
2. Test with various emotional phrases
3. Monitor logs to tune thresholds
4. Integrate with your backend webhook for escalation alerts
5. Add emotion metrics to your weekly/monthly reports

## Dependencies

Make sure these are in your `requirements.txt`:
```
livekit-agents
livekit-plugins-deepgram
livekit-plugins-openai
livekit-plugins-silero
```

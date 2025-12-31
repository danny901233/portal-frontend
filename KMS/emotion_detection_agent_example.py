"""
Enhanced LiveKit Agent with Emotion Detection
Add this to your basic_agent.py or use as a reference
"""

from livekit import agents, rtc
from livekit.agents import JobContext, WorkerOptions, cli
from livekit.plugins import deepgram, openai, silero
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Emotion thresholds
FRUSTRATION_THRESHOLD = 0.6
ANGER_THRESHOLD = 0.8

class EmotionAwareAgent:
    def __init__(self):
        self.current_emotion = None
        self.emotion_history = []
        self.frustration_detected = False
        self.escalation_needed = False
        
    async def detect_emotion_from_transcript(self, text: str) -> dict:
        """
        Analyze text for emotional keywords and patterns
        Returns: {"emotion": "frustrated/angry/calm", "score": 0.0-1.0}
        """
        frustration_keywords = [
            "frustrated", "annoyed", "ridiculous", "waste of time",
            "useless", "terrible", "awful", "sick of", "fed up",
            "unacceptable", "disgrace", "pathetic", "joke"
        ]
        
        anger_keywords = [
            "angry", "furious", "outraged", "disgusting", "appalling",
            "manager", "complaint", "report you", "sue", "lawyer",
            "unbelievable", "incompetent", "worst"
        ]
        
        text_lower = text.lower()
        
        # Count emotional keywords
        frustration_count = sum(1 for word in frustration_keywords if word in text_lower)
        anger_count = sum(1 for word in anger_keywords if word in text_lower)
        
        # Calculate emotion score
        if anger_count > 0:
            score = min(1.0, 0.7 + (anger_count * 0.1))
            emotion = "angry"
        elif frustration_count > 0:
            score = min(1.0, 0.5 + (frustration_count * 0.1))
            emotion = "frustrated"
        else:
            score = 0.0
            emotion = "calm"
            
        return {
            "emotion": emotion,
            "score": score,
            "frustration_keywords": frustration_count,
            "anger_keywords": anger_count
        }
    
    def get_empathetic_response_instruction(self, emotion_data: dict) -> str:
        """
        Return instructions for the AI to adjust its tone based on detected emotion
        """
        emotion = emotion_data.get("emotion", "calm")
        score = emotion_data.get("score", 0.0)
        
        if emotion == "angry" or score >= ANGER_THRESHOLD:
            return """
IMPORTANT: The caller sounds very upset. Please:
1. Acknowledge their frustration immediately: "I completely understand your frustration, and I sincerely apologize."
2. Speak more slowly and calmly
3. Avoid defensive language
4. Offer concrete solutions or next steps
5. Show empathy: "I can hear this has been really difficult for you."
6. If they ask for a manager or continue to be upset, acknowledge: "I understand you'd like to speak with a manager. Let me see how I can help resolve this right now."
"""
        elif emotion == "frustrated" or score >= FRUSTRATION_THRESHOLD:
            return """
IMPORTANT: The caller seems frustrated. Please:
1. Acknowledge their concern: "I understand this is frustrating."
2. Be more patient and thorough in your explanations
3. Use a warm, empathetic tone
4. Avoid rushing through the conversation
5. Validate their feelings: "That's completely understandable."
"""
        else:
            return ""
    
    async def process_user_message(
        self,
        text: str,
        agent_assistant: agents.VoiceAssistant
    ):
        """
        Process incoming user message and adjust agent behavior based on emotion
        """
        # Detect emotion
        emotion_data = await self.detect_emotion_from_transcript(text)
        
        logger.info(f"Emotion detected: {emotion_data}")
        
        # Store in history
        self.emotion_history.append(emotion_data)
        self.current_emotion = emotion_data
        
        # Check if we need to adjust behavior
        if emotion_data["score"] >= FRUSTRATION_THRESHOLD:
            self.frustration_detected = True
            
            # Get empathetic instructions
            empathy_instruction = self.get_empathetic_response_instruction(emotion_data)
            
            # Update the assistant's context with empathetic instructions
            # This tells the LLM to adjust its tone
            logger.warning(f"Frustration detected (score: {emotion_data['score']}) - Adjusting agent tone")
            
        if emotion_data["score"] >= ANGER_THRESHOLD:
            self.escalation_needed = True
            logger.error(f"High anger detected (score: {emotion_data['score']}) - Escalation recommended")
            
        return emotion_data
    
    def should_escalate(self) -> bool:
        """
        Determine if the call should be escalated based on emotion history
        """
        if self.escalation_needed:
            return True
            
        # Check if sustained frustration (3+ frustrated messages in a row)
        if len(self.emotion_history) >= 3:
            recent = self.emotion_history[-3:]
            if all(e["score"] >= FRUSTRATION_THRESHOLD for e in recent):
                return True
                
        return False


async def entrypoint(ctx: JobContext):
    """
    Main agent entrypoint with emotion detection
    """
    logger.info("Agent starting with emotion detection enabled")
    
    # Initialize emotion detector
    emotion_detector = EmotionAwareAgent()
    
    # Connect to the room
    await ctx.connect()
    
    # Configure STT with Deepgram (supports better audio analysis)
    stt = deepgram.STT(
        model="nova-2",
        language="en-US",
        # Deepgram features for better emotion context
        keywords=["frustrated:2", "angry:2", "manager:2", "complaint:2"],
        detect_language=False,
    )
    
    # Configure LLM
    initial_ctx = agents.llm.ChatContext().append(
        role="system",
        text=(
            "You are a helpful garage receptionist AI. "
            "You help customers book appointments and answer questions. "
            "Always be professional, friendly, and empathetic. "
            "If a customer seems frustrated, acknowledge their feelings and try to help."
        ),
    )
    
    # Create voice assistant
    assistant = agents.VoiceAssistant(
        vad=silero.VAD.load(),
        stt=stt,
        llm=openai.LLM(model="gpt-4o"),
        tts=openai.TTS(voice="alloy"),
        chat_ctx=initial_ctx,
    )
    
    # Custom message handler to detect emotion
    @assistant.on("user_speech_committed")
    def on_user_speech(msg: agents.llm.ChatMessage):
        """Called when user finishes speaking"""
        asyncio.create_task(handle_user_speech(msg))
    
    async def handle_user_speech(msg: agents.llm.ChatMessage):
        """Process user speech for emotion detection"""
        user_text = msg.content
        
        # Detect emotion
        emotion_data = await emotion_detector.process_user_message(user_text, assistant)
        
        # If frustrated, add empathetic context to the conversation
        if emotion_data["score"] >= FRUSTRATION_THRESHOLD:
            empathy_instruction = emotion_detector.get_empathetic_response_instruction(emotion_data)
            
            # Add system message to guide the AI's response
            assistant.chat_ctx.messages.append(
                agents.llm.ChatMessage(
                    role="system",
                    content=empathy_instruction
                )
            )
        
        # Check if escalation is needed
        if emotion_detector.should_escalate():
            logger.error("ESCALATION NEEDED - Customer is very upset")
            
            # You could:
            # 1. Send a webhook to your backend
            # 2. Flag the call in your database
            # 3. Transfer to a human agent
            # 4. Send a notification to staff
            
            # Example: Add a gentle escalation message
            assistant.chat_ctx.messages.append(
                agents.llm.ChatMessage(
                    role="system",
                    content="The customer is very upset. Offer to connect them with a manager or take their details for a callback."
                )
            )
    
    # Start the assistant
    assistant.start(ctx.room)
    
    # Greet the caller
    await assistant.say("Hello! Thank you for calling. How can I help you today?")
    
    logger.info("Agent started successfully with emotion detection")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
        )
    )

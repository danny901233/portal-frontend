"""
Test script to simulate the diagnostic booking flow issue.
Extracts user statements from the problematic call and tests the fix.
"""

import asyncio
import os
from livekit import rtc, api
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli
from livekit.plugins import deepgram

# User statements extracted from the call log
USER_STATEMENTS = [
    "Hi, I need to book my car in",
    "It's making a grinding noise when I brake",  # Diagnostic symptom
    "It happens every time I press the brake pedal",  # More details
    "Yes",  # Confirming they have VRN
    "AB12 CDE",  # VRN
    "Yes that's correct",  # Confirming vehicle details
    # After this point, agent should automatically recommend Diagnostic Assessment
]

async def test_diagnostic_flow():
    """
    Simulates the user flow that caused the agent to get stuck.
    Tests if the agent now properly recommends Diagnostic Assessment.
    """
    
    print("=" * 80)
    print("DIAGNOSTIC FLOW TEST")
    print("=" * 80)
    print("\nThis test simulates a user who:")
    print("1. Mentions diagnostic symptoms (grinding noise when braking)")
    print("2. Provides their VRN")
    print("3. Confirms vehicle details")
    print("\nExpected behavior:")
    print("- Agent should automatically recommend 'Diagnostic Assessment'")
    print("- Agent should NOT ask 'What work does your vehicle need?'")
    print("=" * 80)
    print("\n")
    
    print("User statements to test:")
    for i, statement in enumerate(USER_STATEMENTS, 1):
        print(f"{i}. USER: {statement}")
    
    print("\n" + "=" * 80)
    print("MANUAL TEST INSTRUCTIONS")
    print("=" * 80)
    print("\n1. Call the agent phone number")
    print("\n2. Follow this script:")
    print("   " + "\n   ".join([f"- {s}" for s in USER_STATEMENTS]))
    print("\n3. CHECKPOINT: After confirming vehicle details, the agent should:")
    print("   ✅ Say something like: 'Based on what you've told me, I'd recommend'")
    print("   ✅ Suggest 'Diagnostic Assessment'")
    print("   ✅ NOT ask 'What work does your vehicle need?'")
    print("\n4. If the agent automatically suggests Diagnostic Assessment:")
    print("   → FIX SUCCESSFUL ✅")
    print("\n5. If the agent asks 'What work does your vehicle need?':")
    print("   → FIX FAILED ❌ (stuck in same state)")
    print("\n" + "=" * 80)
    print("\nVERSION INFO")
    print("=" * 80)
    print("Latest deployment: v20260303230045")
    print("Fix: Auto-recommend Diagnostic Assessment when diagnostic_notes exist")
    print("Noise cancellation: BVCTelephony (telephony-optimized)")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(test_diagnostic_flow())

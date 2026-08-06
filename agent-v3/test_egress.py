"""
Standalone test for LiveKit egress recording (start + stop).
Tests against gab-garagehive sandbox — does NOT touch production.

Usage:
    cd c:/dev/portal-frontend/agent-v3
    python test_egress.py

Requirements:
    - LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET set in .env or env
    - S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_BUCKET set
    - A room must exist on LiveKit (the script creates a test room first)
"""

import asyncio
import os
import sys
from pathlib import Path

# Load .env from parent dirs
from dotenv import load_dotenv
for candidate in [Path(__file__).parent / ".env", Path(__file__).parent.parent / ".env.local"]:
    if candidate.exists():
        load_dotenv(dotenv_path=candidate, override=False)
        print(f"Loaded env from {candidate}")

from livekit import api as lk_api
from livekit.protocol.egress import (
    RoomCompositeEgressRequest,
    EncodedFileOutput,
    EncodedFileType,
    S3Upload as EgressS3Upload,
    StopEgressRequest,
)

LIVEKIT_URL        = os.getenv("LIVEKIT_URL", "")
S3_ACCESS_KEY_ID   = os.getenv("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "").strip()
S3_REGION          = os.getenv("S3_REGION", "eu-west-2").strip()
S3_BUCKET          = os.getenv("S3_BUCKET", "receptionmate-recordings").strip()
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "").strip()

TEST_ROOM = "egress-test-room"


async def run():
    print(f"\n{'='*50}")
    print("LiveKit Egress Recording — Test Script")
    print(f"{'='*50}")
    print(f"LiveKit URL : {LIVEKIT_URL}")
    print(f"S3 Bucket   : {S3_BUCKET} ({S3_REGION})")
    print(f"Test room   : {TEST_ROOM}")
    print(f"{'='*50}\n")

    # Validate env vars
    missing = [k for k, v in {
        "LIVEKIT_URL": LIVEKIT_URL,
        "S3_ACCESS_KEY_ID": S3_ACCESS_KEY_ID,
        "S3_SECRET_ACCESS_KEY": S3_SECRET_ACCESS_KEY,
        "S3_BUCKET": S3_BUCKET,
    }.items() if not v]
    if missing:
        print(f"FAIL Missing env vars: {', '.join(missing)}")
        sys.exit(1)

    async with lk_api.LiveKitAPI() as lkapi:

        # Step 1: Create test room
        print("1. Creating test room...")
        try:
            room = await lkapi.room.create_room(
                lk_api.CreateRoomRequest(name=TEST_ROOM, empty_timeout=60)
            )
            print(f"   OK Room created: {room.name}")
        except Exception as e:
            print(f"   WARN  Room may already exist: {e}")

        # Step 2: Start egress
        print("2. Starting egress recording...")
        egress_id = None
        try:
            egress_info = await lkapi.egress.start_room_composite_egress(
                RoomCompositeEgressRequest(
                    room_name=TEST_ROOM,
                    file_outputs=[
                        EncodedFileOutput(
                            file_type=EncodedFileType.MP4,
                            filepath=f"{TEST_ROOM}.mp4",
                            s3=EgressS3Upload(
                                access_key=S3_ACCESS_KEY_ID,
                                secret=S3_SECRET_ACCESS_KEY,
                                region=S3_REGION,
                                bucket=S3_BUCKET,
                            ),
                        )
                    ],
                )
            )
            egress_id = egress_info.egress_id
            print(f"   OK Egress started: {egress_id}")
            if RECORDING_BASE_URL:
                print(f"      -> Expected URL: {RECORDING_BASE_URL}/{TEST_ROOM}.mp4")
        except Exception as e:
            print(f"   FAIL Failed to start egress: {e}")
            sys.exit(1)

        # Step 3: Stop egress (the fixed call)
        print("3. Stopping egress recording (using StopEgressRequest)...")
        try:
            await lkapi.egress.stop_egress(
                StopEgressRequest(egress_id=egress_id)
            )
            print(f"   OK Egress stopped successfully")
        except Exception as e:
            print(f"   FAIL Failed to stop egress: {e}")
            sys.exit(1)

        # Step 4: Clean up test room
        print("4. Cleaning up test room...")
        try:
            await lkapi.room.delete_room(
                lk_api.DeleteRoomRequest(room=TEST_ROOM)
            )
            print(f"   OK Room deleted")
        except Exception as e:
            print(f"   WARN  Could not delete room: {e}")

    print(f"\n{'='*50}")
    print("OK ALL TESTS PASSED — safe to deploy to production")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    asyncio.run(run())

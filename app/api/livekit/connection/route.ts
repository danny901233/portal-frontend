import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

export async function POST(request: NextRequest) {
  try {
    const { garageId } = await request.json();

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !wsUrl) {
      return NextResponse.json(
        { error: 'LiveKit credentials not configured' },
        { status: 500 }
      );
    }

    // Create a unique room name for this garage
    const roomName = `garage-${garageId}-${Date.now()}`;
    const participantName = `customer-${Date.now()}`;

    // Create access token
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      name: participantName,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    return NextResponse.json({
      serverUrl: wsUrl,
      participantToken: token,
      roomName,
    });
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    return NextResponse.json(
      { error: 'Failed to generate connection details' },
      { status: 500 }
    );
  }
}

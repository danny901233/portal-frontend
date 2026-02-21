const { RoomServiceClient } = require('livekit-server-sdk');

const LIVEKIT_URL = 'wss://receptionmate-i9q7193z.livekit.cloud';
const LIVEKIT_API_KEY = 'APIEUrrBw7uNvRS';
const LIVEKIT_API_SECRET = 'OBkln4lqukcmj10NNJeTyVWcFCuSMX1yEIwqBSuYItL';

async function disconnectRoom() {
  const roomName = 'garage-4f73c11e-53f5-4591-8531-00717d099f17_+447850699449_ZhUh4UrGzvrY';
  
  const roomService = new RoomServiceClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  );
  
  try {
    console.log(`Attempting to delete room: ${roomName}`);
    await roomService.deleteRoom(roomName);
    console.log('✓ Room deleted successfully!');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

disconnectRoom();

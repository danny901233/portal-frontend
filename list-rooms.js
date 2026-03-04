const { RoomServiceClient } = require('livekit-server-sdk');

const LIVEKIT_URL = 'wss://receptionmate-i9q7193z.livekit.cloud';
const LIVEKIT_API_KEY = 'APIEUrrBw7uNvRS';
const LIVEKIT_API_SECRET = 'OBkln4lqukcmji0NNJeTyVWcFCuSMX1yEIwqBSuYItL';

async function listRooms() {
  const roomService = new RoomServiceClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  );
  
  try {
    console.log('Fetching active rooms...');
    const rooms = await roomService.listRooms();
    console.log(`\nFound ${rooms.length} active rooms:\n`);
    
    rooms.forEach(room => {
      console.log(`Room: ${room.name}`);
      console.log(`  Participants: ${room.numParticipants}`);
      console.log(`  Created: ${new Date(room.creationTime * 1000).toLocaleString()}`);
      console.log('');
    });
    
    const targetRoom = 'garage-4f73c11e-53f5-4591-8531-00717d099f17_+447850699449_ZhUh4UrGzvrY';
    const found = rooms.find(r => r.name === targetRoom);
    
    if (found) {
      console.log('Target room found! Attempting to delete...');
      await roomService.deleteRoom(targetRoom);
      console.log('✓ Room deleted successfully!');
    } else {
      console.log('Target room not found in active rooms list');
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

listRooms();

const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();

const GARAGE_ID = '827efd7f-c5df-47b1-b2b0-f9a5bde39efa';

async function createDummyForGarage() {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: GARAGE_ID },
      include: { agentConfiguration: true },
    });

    if (!garage) {
      console.log('Garage not found.');
      process.exit(1);
    }

    console.log(`Creating conversations for: ${garage.name}\n`);

    // 1. Active WhatsApp conversation
    const customer1 = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'John Smith',
        phone: '+447123456789',
        whatsappId: '+447123456789',
      },
    });

    const conv1 = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer1.id,
        platform: 'whatsapp',
        customerPhone: '+447123456789',
        platformUserId: '+447123456789',
        customerName: 'John Smith',
        status: 'active',
        agentPaused: false,
        needsAttention: false,
        unreadCount: 1,
        lastMessageAt: new Date(),
      },
    });

    const phoneNumber = garage.agentConfiguration?.phoneNumber || 'our phone number';
    const messages1 = [
      { role: 'user', content: 'Hi, I need to book a service for my car', createdAt: new Date(Date.now() - 600000) },
      { role: 'assistant', content: "Hello John! I'd be happy to help you book a service. What type of vehicle do you have and when would you like to bring it in?", createdAt: new Date(Date.now() - 540000) },
      { role: 'user', content: "It's a 2019 Ford Focus. Can I bring it in next Tuesday?", createdAt: new Date(Date.now() - 480000) },
      { role: 'assistant', content: `Perfect! We have availability next Tuesday. To confirm your booking, please give us a call at ${phoneNumber} and we'll get you scheduled. What time works best for you - morning or afternoon?`, createdAt: new Date(Date.now() - 420000) },
      { role: 'user', content: 'Morning would be great, around 9am if possible', createdAt: new Date(Date.now() - 60000) },
    ];

    for (const msg of messages1) {
      await prisma.chatMessage.create({
        data: {
          conversationId: conv1.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        },
      });
    }

    console.log('✓ Created Active WhatsApp conversation (John Smith)');

    // 2. Needs Attention Facebook conversation
    const customer2 = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'Sarah Johnson',
        phone: '+447987654321',
        facebookUserId: 'fb_123456789',
      },
    });

    const conv2 = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer2.id,
        platform: 'facebook',
        platformUserId: 'fb_123456789',
        customerName: 'Sarah Johnson',
        status: 'active',
        agentPaused: true,
        needsAttention: true,
        unreadCount: 2,
        lastMessageAt: new Date(),
      },
    });

    const messages2 = [
      { role: 'user', content: 'My car is making a strange noise and I need urgent help', createdAt: new Date(Date.now() - 900000) },
      { role: 'assistant', content: "I'm sorry to hear that! Can you describe the noise? Is it a grinding, squeaking, or knocking sound? And does it happen when you're driving or when the car is idle?", createdAt: new Date(Date.now() - 840000) },
      { role: 'user', content: "It's a grinding noise when I brake. I'm really worried it might be dangerous", createdAt: new Date(Date.now() - 780000) },
      { role: 'assistant', content: "That does sound like it needs immediate attention - grinding noises when braking could indicate worn brake pads. For safety, I'd recommend not driving the vehicle. Let me flag this for one of our mechanics to contact you right away. Can you confirm your phone number?", createdAt: new Date(Date.now() - 720000) },
      { role: 'user', content: "Yes it's 07987 654321. How soon can someone call me?", createdAt: new Date(Date.now() - 180000) },
      { role: 'user', content: 'Hello? Is anyone there?', createdAt: new Date(Date.now() - 60000) },
    ];

    for (const msg of messages2) {
      await prisma.chatMessage.create({
        data: {
          conversationId: conv2.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        },
      });
    }

    console.log('✓ Created Needs Attention Facebook conversation (Sarah Johnson)');

    // 3. Resolved Instagram conversation
    const customer3 = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'Michael Brown',
        phone: '+447555123456',
        instagramUserId: 'ig_987654321',
      },
    });

    const conv3 = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer3.id,
        platform: 'instagram',
        platformUserId: 'ig_987654321',
        customerName: 'Michael Brown',
        status: 'resolved',
        agentPaused: false,
        needsAttention: false,
        unreadCount: 0,
        lastMessageAt: new Date(Date.now() - 7200000),
      },
    });

    const messages3 = [
      { role: 'user', content: 'What are your opening hours?', createdAt: new Date(Date.now() - 7500000) },
      { role: 'assistant', content: "We're open Monday to Friday from 8:00 AM to 6:00 PM, and Saturday from 9:00 AM to 1:00 PM. We're closed on Sundays. Is there anything else I can help you with?", createdAt: new Date(Date.now() - 7440000) },
      { role: 'user', content: 'Perfect, thank you!', createdAt: new Date(Date.now() - 7380000) },
      { role: 'assistant', content: "You're welcome! Feel free to reach out if you need anything else. Have a great day!", createdAt: new Date(Date.now() - 7320000) },
    ];

    for (const msg of messages3) {
      await prisma.chatMessage.create({
        data: {
          conversationId: conv3.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        },
      });
    }

    console.log('✓ Created Resolved Instagram conversation (Michael Brown)');
    console.log('\n✅ All dummy conversations created successfully!');
    console.log('Refresh the Messages page to see them.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createDummyForGarage();

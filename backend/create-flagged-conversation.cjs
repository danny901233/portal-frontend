const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();

async function createFlaggedConversation() {
  try {
    // Get the first garage
    const garage = await prisma.garage.findFirst({
      include: {
        agentConfiguration: true,
      },
    });

    if (!garage) {
      console.log('No garage found.');
      process.exit(1);
    }

    console.log('Creating flagged conversation for garage:', garage.name);

    // Create another test customer
    const customer = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'Sarah Johnson',
        phone: '+447987654321',
        facebookUserId: 'fb_123456789',
      },
    });

    console.log('Created customer:', customer.name);

    // Create a Facebook Messenger conversation that needs attention
    const conversation = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer.id,
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

    console.log('Created flagged conversation:', conversation.id);

    // Create some messages showing escalation
    const messages = [
      {
        role: 'user',
        content: 'My car is making a strange noise and I need urgent help',
        createdAt: new Date(Date.now() - 900000)
      },
      {
        role: 'assistant',
        content: "I'm sorry to hear that! Can you describe the noise? Is it a grinding, squeaking, or knocking sound? And does it happen when you're driving or when the car is idle?",
        createdAt: new Date(Date.now() - 840000)
      },
      {
        role: 'user',
        content: "It's a grinding noise when I brake. I'm really worried it might be dangerous",
        createdAt: new Date(Date.now() - 780000)
      },
      {
        role: 'assistant',
        content: "That does sound like it needs immediate attention - grinding noises when braking could indicate worn brake pads. For safety, I'd recommend not driving the vehicle. Let me flag this for one of our mechanics to contact you right away. Can you confirm your phone number?",
        createdAt: new Date(Date.now() - 720000)
      },
      {
        role: 'user',
        content: 'Yes it\'s 07987 654321. How soon can someone call me?',
        createdAt: new Date(Date.now() - 180000)
      },
      {
        role: 'user',
        content: 'Hello? Is anyone there?',
        createdAt: new Date(Date.now() - 60000)
      },
    ];

    for (const msg of messages) {
      await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        },
      });
    }

    console.log('Created', messages.length, 'messages');
    console.log('\nFlagged conversation created successfully!');
    console.log('Customer:', customer.name);
    console.log('Platform: Facebook Messenger');
    console.log('Status: NEEDS ATTENTION (flagged)');
    console.log('Agent: Paused');

  } catch (error) {
    console.error('Error creating flagged conversation:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createFlaggedConversation();

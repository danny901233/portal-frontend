const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();

async function createResolvedConversation() {
  try {
    // Get the first garage
    const garage = await prisma.garage.findFirst();

    if (!garage) {
      console.log('No garage found.');
      process.exit(1);
    }

    console.log('Creating resolved conversation for garage:', garage.name);

    // Create another test customer
    const customer = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'Michael Brown',
        phone: '+447555123456',
        instagramUserId: 'ig_987654321',
      },
    });

    console.log('Created customer:', customer.name);

    // Create an Instagram conversation that's been resolved
    const conversation = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer.id,
        platform: 'instagram',
        platformUserId: 'ig_987654321',
        customerName: 'Michael Brown',
        status: 'resolved',
        agentPaused: false,
        needsAttention: false,
        unreadCount: 0,
        lastMessageAt: new Date(Date.now() - 7200000), // 2 hours ago
      },
    });

    console.log('Created resolved conversation:', conversation.id);

    // Create some messages showing a completed interaction
    const messages = [
      {
        role: 'user',
        content: 'What are your opening hours?',
        createdAt: new Date(Date.now() - 7500000)
      },
      {
        role: 'assistant',
        content: "We're open Monday to Friday from 8:00 AM to 6:00 PM, and Saturday from 9:00 AM to 1:00 PM. We're closed on Sundays. Is there anything else I can help you with?",
        createdAt: new Date(Date.now() - 7440000)
      },
      {
        role: 'user',
        content: 'Perfect, thank you!',
        createdAt: new Date(Date.now() - 7380000)
      },
      {
        role: 'assistant',
        content: "You're welcome! Feel free to reach out if you need anything else. Have a great day!",
        createdAt: new Date(Date.now() - 7320000)
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
    console.log('\nResolved conversation created successfully!');
    console.log('Customer:', customer.name);
    console.log('Platform: Instagram');
    console.log('Status: RESOLVED');

  } catch (error) {
    console.error('Error creating resolved conversation:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createResolvedConversation();

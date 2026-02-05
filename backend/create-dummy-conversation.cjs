const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();

async function createDummyConversation() {
  try {
    // Get the first garage
    const garage = await prisma.garage.findFirst({
      include: {
        agentConfiguration: true,
      },
    });

    if (!garage) {
      console.log('No garage found. Please create a garage first.');
      process.exit(1);
    }

    console.log('Creating dummy conversation for garage:', garage.name);

    // Create a test customer
    const customer = await prisma.customer.create({
      data: {
        garageId: garage.id,
        name: 'John Smith',
        phone: '+447123456789',
        whatsappId: '+447123456789',
      },
    });

    console.log('Created customer:', customer.name);

    // Create a WhatsApp conversation
    const conversation = await prisma.chatConversation.create({
      data: {
        garageId: garage.id,
        customerId: customer.id,
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

    console.log('Created conversation:', conversation.id);

    // Create some messages
    const phoneNumber = garage.agentConfiguration?.phoneNumber || 'our phone number';
    const messages = [
      {
        role: 'user',
        content: 'Hi, I need to book a service for my car',
        createdAt: new Date(Date.now() - 600000)
      },
      {
        role: 'assistant',
        content: "Hello John! I'd be happy to help you book a service. What type of vehicle do you have and when would you like to bring it in?",
        createdAt: new Date(Date.now() - 540000)
      },
      {
        role: 'user',
        content: "It's a 2019 Ford Focus. Can I bring it in next Tuesday?",
        createdAt: new Date(Date.now() - 480000)
      },
      {
        role: 'assistant',
        content: `Perfect! We have availability next Tuesday. To confirm your booking, please give us a call at ${phoneNumber} and we'll get you scheduled. What time works best for you - morning or afternoon?`,
        createdAt: new Date(Date.now() - 420000)
      },
      {
        role: 'user',
        content: 'Morning would be great, around 9am if possible',
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
    console.log('\nDummy conversation created successfully!');
    console.log('Customer:', customer.name);
    console.log('Phone:', customer.phone);
    console.log('Platform: WhatsApp');
    console.log('\nYou can now view this conversation in the Messages page.');

  } catch (error) {
    console.error('Error creating dummy conversation:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createDummyConversation();

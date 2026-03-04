import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteUserAndBusiness(email: string) {
  console.log(`\n🔍 Looking up user with email: ${email}`);
  
  try {
    // Find the user
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        garageAccessIds: true,
      }
    });

    if (!user) {
      console.log('❌ User not found');
      return;
    }

    console.log(`✓ Found user: ${user.id}`);
    console.log(`  Garage Access IDs: ${user.garageAccessIds.join(', ')}`);

    // Find all garages the user has access to
    const garages = await prisma.garage.findMany({
      where: {
        id: { in: user.garageAccessIds }
      },
      include: {
        business: true,
        agentConfiguration: true,
        calls: true,
        knowledgeDocuments: true,
        conversations: true,
        socialMediaConnections: true,
        customers: true,
        smsBookingLinks: true,
        invoices: true,
      }
    });

    console.log(`\n📊 Found ${garages.length} garage(s):`);
    
    const businessIds = new Set<string>();
    
    for (const garage of garages) {
      console.log(`\n  Garage: ${garage.name} (${garage.id})`);
      console.log(`    Business: ${garage.business?.name || 'None'} (${garage.businessId || 'None'})`);
      console.log(`    Calls: ${garage.calls.length}`);
      console.log(`    Conversations: ${garage.conversations.length}`);
      console.log(`    Customers: ${garage.customers.length}`);
      console.log(`    SMS Booking Links: ${garage.smsBookingLinks.length}`);
      console.log(`    Invoices: ${garage.invoices.length}`);
      console.log(`    Knowledge Documents: ${garage.knowledgeDocuments.length}`);
      console.log(`    Social Media Connections: ${garage.socialMediaConnections.length}`);
      console.log(`    Agent Configuration: ${garage.agentConfiguration ? 'Yes' : 'No'}`);
      
      if (garage.businessId) {
        businessIds.add(garage.businessId);
      }
    }

    console.log(`\n⚠️  This will delete:`);
    console.log(`   - 1 user account (${email})`);
    console.log(`   - ${garages.length} garage(s)`);
    console.log(`   - ${businessIds.size} business(es)`);
    console.log(`   - All associated calls, conversations, customers, invoices, etc.`);
    
    // Perform the deletion
    console.log(`\n🗑️  Starting deletion process...`);

    // Delete in the correct order due to foreign key constraints
    
    for (const garage of garages) {
      console.log(`\n  Deleting data for garage: ${garage.name}`);
      
      // Delete related data (most will cascade, but being explicit)
      await prisma.callFeedback.deleteMany({
        where: {
          call: {
            garageId: garage.id
          }
        }
      });
      console.log(`    ✓ Deleted call feedback`);
      
      await prisma.chatMessage.deleteMany({
        where: {
          conversation: {
            garageId: garage.id
          }
        }
      });
      console.log(`    ✓ Deleted chat messages`);
      
      await prisma.chatConversation.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted conversations`);
      
      await prisma.call.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted calls`);
      
      await prisma.customer.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted customers`);
      
      await prisma.invoice.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted invoices`);
      
      await prisma.smsBookingLink.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted SMS booking links`);
      
      await prisma.agentKnowledgeDocument.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted knowledge documents`);
      
      await prisma.socialMediaConnection.deleteMany({
        where: { garageId: garage.id }
      });
      console.log(`    ✓ Deleted social media connections`);
      
      if (garage.agentConfiguration) {
        await prisma.agentConfiguration.delete({
          where: { garageId: garage.id }
        });
        console.log(`    ✓ Deleted agent configuration`);
      }
      
      // Delete the garage itself
      await prisma.garage.delete({
        where: { id: garage.id }
      });
      console.log(`    ✓ Deleted garage`);
    }

    // Delete businesses
    for (const businessId of businessIds) {
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        include: { garages: true }
      });
      
      if (business && business.garages.length === 0) {
        await prisma.business.delete({
          where: { id: businessId }
        });
        console.log(`  ✓ Deleted business: ${business.name}`);
      }
    }

    // Finally, delete the user
    await prisma.user.delete({
      where: { id: user.id }
    });
    console.log(`  ✓ Deleted user: ${email}`);

    console.log(`\n✅ Deletion completed successfully!`);
    
  } catch (error) {
    console.error('\n❌ Error during deletion:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Get email from command line argument
const email = process.argv[2];

if (!email) {
  console.error('❌ Please provide an email address');
  console.log('Usage: npx ts-node scripts/delete-user-and-business.ts <email>');
  process.exit(1);
}

deleteUserAndBusiness(email)
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

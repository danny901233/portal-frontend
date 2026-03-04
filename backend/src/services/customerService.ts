import { prisma } from '../db.js';

interface CustomerIdentifiers {
  garageId: string;
  phone?: string;
  email?: string;
  whatsappId?: string;
  facebookUserId?: string;
  instagramUserId?: string;
  name?: string;
}

/**
 * Find or create a customer based on available identifiers
 * Matches by phone, email, or social media IDs
 */
export async function findOrCreateCustomer(
  identifiers: CustomerIdentifiers
): Promise<string> {
  const { garageId, phone, email, whatsappId, facebookUserId, instagramUserId, name } = identifiers;

  // Try to find existing customer by any matching identifier
  const whereConditions = [];

  if (phone) {
    whereConditions.push({ garageId, phone });
  }
  if (email) {
    whereConditions.push({ garageId, email });
  }
  if (whatsappId) {
    whereConditions.push({ garageId, whatsappId });
  }
  if (facebookUserId) {
    whereConditions.push({ garageId, facebookUserId });
  }
  if (instagramUserId) {
    whereConditions.push({ garageId, instagramUserId });
  }

  if (whereConditions.length > 0) {
    const existingCustomer = await prisma.customer.findFirst({
      where: {
        OR: whereConditions,
      },
    });

    if (existingCustomer) {
      // Update customer with any new identifiers
      await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: {
          phone: phone || existingCustomer.phone,
          email: email || existingCustomer.email,
          whatsappId: whatsappId || existingCustomer.whatsappId,
          facebookUserId: facebookUserId || existingCustomer.facebookUserId,
          instagramUserId: instagramUserId || existingCustomer.instagramUserId,
          name: name || existingCustomer.name,
        },
      });

      return existingCustomer.id;
    }
  }

  // Create new customer
  const newCustomer = await prisma.customer.create({
    data: {
      garageId,
      phone,
      email,
      whatsappId,
      facebookUserId,
      instagramUserId,
      name,
    },
  });

  return newCustomer.id;
}

/**
 * Link a conversation to a customer
 */
export async function linkConversationToCustomer(
  conversationId: string,
  customerId: string
): Promise<void> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { customerId },
  });
}

/**
 * Get all conversations for a customer across all platforms
 */
export async function getCustomerConversations(customerId: string) {
  return await prisma.chatConversation.findMany({
    where: { customerId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { lastMessageAt: 'desc' },
  });
}

/**
 * Get customer details with all identifiers
 */
export async function getCustomer(customerId: string) {
  return await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      conversations: {
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { lastMessageAt: 'desc' },
      },
    },
  });
}

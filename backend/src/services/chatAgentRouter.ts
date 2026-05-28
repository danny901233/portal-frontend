import { prisma } from '../db.js';
import { getChatAgentResponse as getGHResponse } from './chatAgentV2.js';
import { getTyresoftChatResponse } from './chatAgentTyresoft.js';

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

interface SeedContact {
  phone?: string;
  name?: string;
}

// Per-conversation mutex — prevents two simultaneous messages for the same
// conversation from racing on session state (double messages, clobbered saves).
// Works within a single PM2 fork process, which is sufficient.
const convLocks = new Map<string, Promise<void>>();

async function withConvLock<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const prev = convLocks.get(convId);
  let unlock!: () => void;
  const lock = new Promise<void>(r => { unlock = r; });
  convLocks.set(convId, lock);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    unlock();
    if (convLocks.get(convId) === lock) convLocks.delete(convId);
  }
}

/**
 * Route an incoming chat message to the correct agent based on the garage's
 * agentScript setting stored in AgentConfiguration.
 *
 *   agentScript === 'tyresoft-agent'  → Tyresoft chat agent
 *   anything else                     → GarageHive chat agent (chatAgentV2)
 */
export async function routeChatMessage(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: SeedContact,
  imageUrl?: string
): Promise<ChatAgentResponse> {
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { agentScript: true },
  });

  const agentScript = config?.agentScript || '';

  console.log(`[CHAT_ROUTER] garageId=${garageId} agentScript=${agentScript || '(default)'}`);

  return withConvLock(conversationId, async () => {
    if (agentScript === 'tyresoft-agent') {
      return getTyresoftChatResponse(garageId, message, conversationId, seedContact);
    }

    // Default: GarageHive (chatAgentV2)
    return getGHResponse(garageId, message, conversationId, seedContact, imageUrl);
  });
}

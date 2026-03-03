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
  seedContact?: SeedContact
): Promise<ChatAgentResponse> {
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { agentScript: true },
  });

  const agentScript = config?.agentScript || '';

  console.log(`[CHAT_ROUTER] garageId=${garageId} agentScript=${agentScript || '(default)'}`);

  if (agentScript === 'tyresoft-agent') {
    return getTyresoftChatResponse(garageId, message, conversationId, seedContact);
  }

  // Default: GarageHive (chatAgentV2)
  return getGHResponse(garageId, message, conversationId, seedContact);
}

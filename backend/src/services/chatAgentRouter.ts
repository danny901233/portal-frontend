import { prisma } from '../db.js';
import { getChatAgentResponse as getGHResponse } from './chatAgentV2.js';
import { getTyresoftChatResponse } from './chatAgentTyresoft.js';
import { getAssistChatResponse } from './chatAgentAssist.js';
import { getMMHChatResponse } from './chatAgentMMH.js';

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

// Does this garage have working GarageHive credentials? Mirrors chatAgentV2's own check
// (supports nested { garagehive: {...} } and flat formats). A garage with a live diary must
// use the GarageHive agent — never the Assist agent, which would offer synthetic/fake slots.
function hasGarageHiveCreds(ipc: unknown): boolean {
  if (!ipc || typeof ipc !== 'object') return false;
  const raw = ipc as Record<string, any>;
  const gh = raw.garagehive || raw;
  const customerId = gh.ghCustomerId || gh.customerId;
  const apiKey = gh.ghApiKey || gh.apiKey;
  return !!(customerId && apiKey);
}

/**
 * Route an incoming chat message to the correct agent — one per garage type,
 * mirroring the three voice agents:
 *   agentScript === 'tyresoft-agent'  → Tyresoft chat agent
 *   live GarageHive diary (creds)     → GarageHive chat agent (chatAgentV2) — real bookings + GH tools
 *   agentType === 'assist' (no diary) → Assist chat agent (message-taking + synthetic slots)
 *   otherwise                         → GarageHive chat agent (chatAgentV2)
 *
 * GarageHive creds take priority over agentType on purpose: a garage with a real diary must never
 * be diverted to the Assist agent (which offers synthetic slots), even if agentType is mislabeled.
 */
export { invalidateSessionCache } from './chatAgentV2.js';

export async function routeChatMessage(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: SeedContact
): Promise<ChatAgentResponse> {
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { agentScript: true, agentType: true, integrationProviderConfig: true },
  });

  const agentScript = config?.agentScript || '';
  const agentType = config?.agentType || '';
  const hasGH = hasGarageHiveCreds(config?.integrationProviderConfig);

  console.log(`[CHAT_ROUTER] garageId=${garageId} agentScript=${agentScript || '(default)'} agentType=${agentType || '(default)'} gh=${hasGH}`);

  return withConvLock(conversationId, async () => {
    if (agentScript === 'MMH-agent') {
      return getMMHChatResponse(garageId, message, conversationId, seedContact);
    }

    if (agentScript === 'tyresoft-agent') {
      return getTyresoftChatResponse(garageId, message, conversationId, seedContact);
    }

    // A live GarageHive diary always wins — real bookings + GarageHive tool calls.
    if (hasGH) {
      return getGHResponse(garageId, message, conversationId, seedContact);
    }

    // No diary integration + flagged assist → message-taking + synthetic-slot bookings.
    if (agentType === 'assist') {
      return getAssistChatResponse(garageId, message, conversationId, seedContact);
    }

    // Default: GarageHive / automate (chatAgentV2)
    return getGHResponse(garageId, message, conversationId, seedContact);
  });
}

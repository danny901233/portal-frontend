import { withAiContext } from '../utils/aiUsage.js';
import { prisma } from '../db.js';
import { getChatAgentResponse as getGHResponse } from './chatAgentV2.js';
import { getTyresoftChatResponse } from './chatAgentTyresoft.js';
import { getAssistChatResponse } from './chatAgentAssist.js';
import { getMMHChatResponse } from './chatAgentMMH.js';
import { getPooleChatResponse } from './chatAgentPoole.js';
import { getBookarChatResponse } from './chatAgentBookar.js';

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

interface SeedContact {
  phone?: string;
  name?: string;
  /** How long since the customer last messaged, e.g. "yesterday", "4 days ago". Set only when
   *  the thread has been dormant, so the agent can open naturally instead of resuming
   *  mid-sentence. Agents that don't read it are unaffected. */
  lastContact?: string;
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
 * Which diary a garage's CREDENTIALS say it uses, for when agentScript does not say.
 *
 * agentScript was the only signal, and the v3 -> unified migration on 2026-09-21 rewrote it
 * to 'unified-agent' for every automate garage. That silently disconnected the branches below
 * it: EAC Telford went from agentScript 'bookar-agent' — which routed to the Bookar chat agent
 * — to falling through to the GarageHive agent with no GarageHive credentials, which answers
 * every enquiry with "let me take your details and the team will call you back". Eight
 * conversations, zero bookings.
 *
 * The voice side already works this way: build_diary() infers the diary from the credentials
 * present, which is why EAC's PHONE line kept booking throughout. Chat now does the same, so
 * the next rename of agentScript cannot quietly unplug a garage's diary again.
 *
 * Key names mirror each chat agent's own resolver exactly — nested block first, then flat.
 */
function credsSay(ipc: unknown): 'bookar' | 'poole' | 'tyresoft' | null {
  if (!ipc || typeof ipc !== 'object') return null;
  const raw = ipc as Record<string, any>;

  const bk = raw.bookar || raw;
  if ((bk.bookarClientId || bk.clientId) && (bk.bookarClientSecret || bk.clientSecret)) return 'bookar';

  const ts = raw.tyresoft || raw;
  if ((ts.tsWorkspace || ts.workspace) && (ts.tsUsername || ts.username)
      && (ts.tsPassword || ts.password) && (ts.tsApiKey || ts.apiKey)) return 'tyresoft';

  // Poole LAST and deliberately strict: its only required credential is a branch key, and
  // `apiKey` is too common a name to treat as a Poole signal.
  const pl = raw.poole || raw.pooleSettings || raw;
  if (pl.branchKey || pl.pooleBranchKey) return 'poole';

  return null;
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
 *   agentScript === 'bookar-agent'    → Bookar chat agent (Vitara Commerce API)
 *   live GarageHive diary (creds)     → GarageHive chat agent (chatAgentV2) — real bookings + GH tools
 *   agentType === 'assist' (no diary) → Assist chat agent (message-taking + synthetic slots)
 *   otherwise                         → GarageHive chat agent (chatAgentV2)
 *
 * GarageHive creds take priority over agentType on purpose: a garage with a real diary must never
 * be diverted to the Assist agent (which offers synthetic slots), even if agentType is mislabeled.
 */
export { invalidateSessionCache } from './chatAgentV2.js';

/**
 * Every chat turn passes through here, whichever agent ends up handling it — so this is where the
 * cost accounting gets its context. One wrap, and every model call underneath it is attributed to
 * this garage and conversation without a single call site having to pass anything down.
 */
export async function routeChatMessage(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: SeedContact
): Promise<ChatAgentResponse> {
  const conv = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { platform: true },
  }).catch(() => null);

  return withAiContext(
    { garageId, conversationId, channel: conv?.platform ?? null },
    () => routeChatMessageInner(garageId, message, conversationId, seedContact),
  );
}

async function routeChatMessageInner(
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
    if (agentScript === 'poole-agent') {
      return getPooleChatResponse(garageId, message, conversationId, seedContact);
    }

    if (agentScript === 'MMH-agent') {
      return getMMHChatResponse(garageId, message, conversationId, seedContact);
    }

    if (agentScript === 'tyresoft-agent') {
      return getTyresoftChatResponse(garageId, message, conversationId, seedContact);
    }

    if (agentScript === 'bookar-agent') {
      return getBookarChatResponse(garageId, message, conversationId, seedContact);
    }

    // A live GarageHive diary always wins — real bookings + GarageHive tool calls.
    if (hasGH) {
      return getGHResponse(garageId, message, conversationId, seedContact);
    }

    // agentScript did not name a diary and there are no GarageHive credentials — so ask the
    // credentials. Placed after the GarageHive check on purpose: every garage routing correctly
    // today keeps routing exactly where it does now, and this only catches the ones that were
    // falling through to a GarageHive agent that has nothing to work with.
    const byCreds = credsSay(config?.integrationProviderConfig);
    if (byCreds) {
      console.log(`[CHAT_ROUTER] agentScript did not name a diary — credentials say ${byCreds}`);
      if (byCreds === 'bookar') {
        return getBookarChatResponse(garageId, message, conversationId, seedContact);
      }
      if (byCreds === 'tyresoft') {
        return getTyresoftChatResponse(garageId, message, conversationId, seedContact);
      }
      return getPooleChatResponse(garageId, message, conversationId, seedContact);
    }

    // No diary integration + flagged assist → message-taking + synthetic-slot bookings.
    if (agentType === 'assist') {
      return getAssistChatResponse(garageId, message, conversationId, seedContact);
    }

    // Default: GarageHive / automate (chatAgentV2)
    return getGHResponse(garageId, message, conversationId, seedContact);
  });
}

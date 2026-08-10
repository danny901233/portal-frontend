import { prisma } from '../db.js';

// Fire-and-forget observability for the chat agents: records one ChatToolCall row per tool
// invocation (tool name, args, result, success, latency). Never blocks or breaks the chat —
// any failure (incl. FK misses for throwaway conversation ids) is swallowed and logged.
// Success convention matches the agents: a result with an `error` key = failure, else success.
export function logChatToolCall(params: {
  conversationId: string;
  garageId: string;
  agentType: string; // assist | automate | tyresoft
  toolName: string;
  args: any;
  result: any;
  durationMs: number;
}): void {
  const { conversationId, garageId, agentType, toolName, args, result, durationMs } = params;
  if (!conversationId || !garageId) return;

  const success = !(result && typeof result === 'object' && 'error' in result);
  const errorMessage = success
    ? null
    : String((result && (result as any).error) ?? 'unknown error').slice(0, 500);

  // Keep stored payloads bounded so a large API echo can't bloat the table.
  const cap = (v: any) => {
    if (v == null) return undefined;
    try {
      const s = JSON.stringify(v);
      return s.length > 8000 ? { _truncated: true, preview: s.slice(0, 8000) } : v;
    } catch {
      return undefined;
    }
  };

  prisma.chatToolCall
    .create({
      data: {
        conversationId,
        garageId,
        agentType,
        toolName,
        args: cap(args),
        result: cap(result),
        success,
        errorMessage,
        durationMs: Math.max(0, Math.round(durationMs || 0)),
      },
    })
    .catch((e: any) => console.error(`[CHAT_TOOL_LOG] failed for ${toolName}:`, e?.message));
}

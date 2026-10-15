import { prisma } from '../db.js';

// Fire-and-forget observability for the chat agents: records one ChatToolCall row per tool
// invocation (tool name, args, result, success, latency). Never blocks or breaks the chat —
// any failure (incl. FK misses for throwaway conversation ids) is swallowed and logged.
// Success convention matches the agents: a result with an `error` key, or a string starting
// TOOL_FAILED:, = failure; anything else = success.

export const TOOL_FAILED_PREFIX = 'TOOL_FAILED:';

/**
 * Decide whether a tool outcome was a failure, and extract a one-line reason.
 *
 * Tool handlers return a string of instructions for the model, so they cannot signal failure
 * through an `error` key — which meant every string was logged green. A select_service that could
 * not load a service catalogue sat in the diagnostics as a successful call while the customer was
 * left unanswered and never written to again (Speedy Spanners, 14 Oct 2026). Handlers now prefix
 * an unrecoverable outcome with TOOL_FAILED:, and only that prefix reclassifies a string — the
 * ALL-CAPS sentinels the agents already use (SERVICE_NOT_AVAILABLE, NO_SERVICE_MATCH, …) are
 * ordinary, recoverable outcomes and must stay successful.
 */
export function classifyToolResult(result: any): { success: boolean; errorMessage: string | null } {
  const failedString = typeof result === 'string' && result.startsWith(TOOL_FAILED_PREFIX);
  const failedObject = !!(result && typeof result === 'object' && 'error' in result);

  if (!failedString && !failedObject) return { success: true, errorMessage: null };

  const reason = failedString
    ? (result as string).slice(TOOL_FAILED_PREFIX.length).trim().split('\n')[0]
    : String((result as any).error ?? 'unknown error');

  return { success: false, errorMessage: (reason || 'unknown error').slice(0, 500) };
}

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

  const { success, errorMessage } = classifyToolResult(result);

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

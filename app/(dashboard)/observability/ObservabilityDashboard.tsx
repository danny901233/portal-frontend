'use client';

import { useEffect, useState } from 'react';
import { getGarageId, getSessionToken, isReceptionMateStaff, setGarageId } from '../../lib/auth';
import { useBranchScope } from '../../lib/branchScope';

// --- Types ---

interface ToolCall {
  tool_name: string;
  duration_ms: number;
  success: boolean;
  error_type?: string;
  error?: string;
  parameters?: any;
}

interface ConversationMetrics {
  _turn_count?: number;
  turn_count?: number;
  _interruption_count?: number;
  interruption_count?: number;
  avg_agent_response_latency_ms?: number;
  [key: string]: any;
}

interface CallData {
  id: string;
  createdAt: string;
  duration: number;
  intent?: string;
  customerPhone?: string;
  garageId?: string;
  transcript?: any;
  metrics?: {
    tool_calls?: ToolCall[];
    tool_call_count?: number;
    failed_tool_calls?: number;
    total_tool_latency_ms?: number;
    avg_llm_latency_ms?: number;
    conversation_metrics?: ConversationMetrics;
    vrn_attempts?: number;
  };
}

interface AggregatedStats {
  totalCalls: number;
  avgCallDuration: number;
  totalToolCalls: number;
  failedToolCalls: number;
  avgLlmLatency: number;
  avgInterruptions: number;
  toolPerformance: {
    [toolName: string]: {
      count: number;
      successRate: number;
      avgLatency: number;
      errors: { type: string; count: number; message: string }[];
    };
  };
  topErrors: { type: string; count: number; message: string }[];
  registrationMetrics: {
    callsWithRegLookup: number;
    callsWithMultipleAttempts: number;
    firstAttemptSuccessRate: number;
    retryRate: number;
    partialCaptureCount: number;
    notFoundCount: number;
    threeOrMoreAttemptsCount: number;
  };
  bookingMetrics: {
    bookingIntentCalls: number;
    completedBookings: number;
    abandonedBookings: number;
    conversionRate: number;
    noTimeslotsCount: number;
    costConcernCount: number;
    noMatchingServiceCount: number;
    humanRequestCount: number;
    otherReasonsCount: number;
  };
}

interface EvaluatorConfig {
  highLatency: { enabled: boolean; threshold: number };
  highInterruptions: { enabled: boolean; threshold: number };
  highFailureRate: { enabled: boolean; threshold: number };
}

interface FlaggedCall {
  call: CallData;
  reasons: string[];
}

interface RegistrationIssueCall {
  call: CallData;
  issueType: 'partial' | 'notFound' | 'persistent';
  attempts: number;
  details: string;
}

interface BookingAbandonmentCall {
  call: CallData;
  reason: 'noTimeslots' | 'cost' | 'noMatchingService' | 'humanRequest' | 'other';
  details: string;
}

// Per-garage totals for the staff branch leaderboard (from /api/staff/garage-stats).
interface GarageStat {
  garageId: string;
  name: string;
  callCount: number;
  bookingCount: number;
  totalDurationSeconds: number;
  capturedRevenue: number;
}

// Chat-agent tool-call health for the staff observability tile (from /api/staff/chat-tool-stats).
interface ChatToolStats {
  overall: { total: number; success: number; failed: number; successRate: number };
  byAgent: { agentType: string; total: number; success: number; failed: number; successRate: number }[];
  byTool: { agentType: string; toolName: string; total: number; success: number; failed: number; successRate: number; avgMs: number }[];
  recentFailures: {
    id: string;
    conversationId: string;
    garageId: string;
    garageName: string;
    agentType: string;
    toolName: string;
    errorMessage: string | null;
    durationMs: number | null;
    createdAt: string;
  }[];
}

// --- Constants ---

const DEFAULT_EVALUATORS: EvaluatorConfig = {
  highLatency: { enabled: true, threshold: 3000 },
  highInterruptions: { enabled: true, threshold: 3 },
  highFailureRate: { enabled: true, threshold: 20 },
};

const EVALUATORS_STORAGE_KEY = 'rm_evaluator_config';

// --- Module-level helpers ---

function getInterruptionCount(call: CallData): number {
  const cm = call.metrics?.conversation_metrics;
  return cm?._interruption_count ?? cm?.interruption_count ?? 0;
}

function computeFlaggedCalls(callsData: CallData[], config: EvaluatorConfig): FlaggedCall[] {
  const flagged: FlaggedCall[] = [];

  callsData.forEach((call) => {
    const reasons: string[] = [];
    const toolCalls = call.metrics?.tool_calls || [];
    const failedTools = toolCalls.filter((tc) => !tc.success).length;

    if (config.highLatency.enabled) {
      const latency = call.metrics?.avg_llm_latency_ms ?? 0;
      if (latency > config.highLatency.threshold) {
        reasons.push(`LLM latency ${Math.round(latency)}ms > ${config.highLatency.threshold}ms`);
      }
    }

    if (config.highInterruptions.enabled) {
      const interruptions = getInterruptionCount(call);
      if (interruptions > config.highInterruptions.threshold) {
        reasons.push(`${interruptions} interruptions > ${config.highInterruptions.threshold}`);
      }
    }

    if (config.highFailureRate.enabled && toolCalls.length > 0) {
      const rate = (failedTools / toolCalls.length) * 100;
      if (rate > config.highFailureRate.threshold) {
        reasons.push(`Tool failure ${rate.toFixed(0)}% > ${config.highFailureRate.threshold}%`);
      }
    }

    if (reasons.length > 0) flagged.push({ call, reasons });
  });

  return flagged.sort(
    (a, b) => new Date(b.call.createdAt).getTime() - new Date(a.call.createdAt).getTime()
  );
}

// --- Component ---

export function ObservabilityDashboard() {
  const { scope, allowAllAssignedOption, selectedGarageId, assignedGarageIds } = useBranchScope();
  // "All branches" selected at the top → aggregate every garage; otherwise drill into one branch.
  const aggregateAllBranches = scope === 'all' && allowAllAssignedOption;
  const [timeRange, setTimeRange] = useState('24h');
  // Custom date range (used when timeRange === 'custom') + hide-reviewed toggle for the flagged worklist.
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [hideReviewed, setHideReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<CallData[]>([]);
  const [stats, setStats] = useState<AggregatedStats>({
    totalCalls: 0,
    avgCallDuration: 0,
    totalToolCalls: 0,
    failedToolCalls: 0,
    avgLlmLatency: 0,
    avgInterruptions: 0,
    toolPerformance: {},
    topErrors: [],
    registrationMetrics: {
      callsWithRegLookup: 0,
      callsWithMultipleAttempts: 0,
      firstAttemptSuccessRate: 0,
      retryRate: 0,
      partialCaptureCount: 0,
      notFoundCount: 0,
      threeOrMoreAttemptsCount: 0,
    },
    bookingMetrics: {
      bookingIntentCalls: 0,
      completedBookings: 0,
      abandonedBookings: 0,
      conversionRate: 0,
      noTimeslotsCount: 0,
      costConcernCount: 0,
      noMatchingServiceCount: 0,
      humanRequestCount: 0,
      otherReasonsCount: 0,
    },
  });
  const [activeTab, setActiveTab] = useState<'flagged' | 'tools' | 'errors' | 'registrations' | 'calls'>('flagged');
  const [evaluators, setEvaluators] = useState<EvaluatorConfig>(DEFAULT_EVALUATORS);
  const [flaggedCalls, setFlaggedCalls] = useState<FlaggedCall[]>([]);
  const [showEvaluatorConfig, setShowEvaluatorConfig] = useState(true);
  const [registrationIssueCalls, setRegistrationIssueCalls] = useState<RegistrationIssueCall[]>([]);
  const [expandedIssueType, setExpandedIssueType] = useState<'partial' | 'notFound' | 'persistent' | null>(null);
  const [bookingAbandonmentCalls, setBookingAbandonmentCalls] = useState<BookingAbandonmentCall[]>([]);
  const [expandedAbandonmentReason, setExpandedAbandonmentReason] = useState<'noTimeslots' | 'cost' | 'noMatchingService' | 'humanRequest' | 'other' | null>(null);
  const [garageStats, setGarageStats] = useState<GarageStat[]>([]);
  const [chatToolStats, setChatToolStats] = useState<ChatToolStats | null>(null);
  const [garageStatMetric, setGarageStatMetric] = useState<'callCount' | 'bookingCount' | 'totalDurationSeconds' | 'capturedRevenue'>('callCount');
  // Failure-type filter for the AI-flagged worklist (null = show all).
  const [flaggedCategoryFilter, setFlaggedCategoryFilter] = useState<string | null>(null);

  // Load evaluators from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(EVALUATORS_STORAGE_KEY);
      if (stored) setEvaluators(JSON.parse(stored));
    } catch {}
  }, []);

  // Save evaluators and recompute flagged calls whenever either changes
  useEffect(() => {
    try {
      localStorage.setItem(EVALUATORS_STORAGE_KEY, JSON.stringify(evaluators));
    } catch {}
    setFlaggedCalls(computeFlaggedCalls(calls, evaluators));
  }, [evaluators, calls]);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange, customStart, customEnd, aggregateAllBranches, selectedGarageId, assignedGarageIds]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 'any' = cross-garage aggregate (all branches); otherwise the selected branch.
      const garageId = aggregateAllBranches ? 'any' : (selectedGarageId || getGarageId() || 'any');
      const token = getSessionToken();

      if (!token) {
        console.error('No session token found');
        return;
      }

      const now = new Date();
      const startDate = new Date();
      let endDate = now;
      if (timeRange === 'custom') {
        if (customStart) startDate.setTime(new Date(customStart).getTime());
        else startDate.setDate(now.getDate() - 7);
        if (customEnd) {
          endDate = new Date(customEnd);
          endDate.setHours(23, 59, 59, 999); // inclusive end-of-day
        }
      } else if (timeRange === '24h') startDate.setHours(now.getHours() - 24);
      else if (timeRange === '7d') startDate.setDate(now.getDate() - 7);
      else if (timeRange === '30d') startDate.setDate(now.getDate() - 30);

      const params = new URLSearchParams({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        pageSize: '10000',
      });
      // Cross-garage aggregate: the backend keys off an explicit garageIds list — the
      // 'any' path segment alone matches no rows. Single branch uses the path garage id.
      if (aggregateAllBranches) {
        assignedGarageIds.forEach((id) => params.append('garageIds', id));
      }

      const response = await fetch(
        `/api/garages/${garageId}/calls?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch calls');

      const data = await response.json();
      const callsData: CallData[] = data.calls || [];
      setCalls(callsData);
      aggregateStats(callsData);

      // Staff branch leaderboard — cross-garage totals, aggregated server-side.
      try {
        const statsRes = await fetch(
          `/api/staff/garage-stats?startDate=${startDate.toISOString()}&endDate=${now.toISOString()}`,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          setGarageStats(statsData.stats || []);
        }
      } catch (statErr) {
        console.error('Error fetching garage stats:', statErr);
      }

      // Staff chat-agent tool-call observability — success rates + recent failures.
      try {
        if (isReceptionMateStaff()) {
          const ctRes = await fetch(
            `/api/staff/chat-tool-stats?startDate=${startDate.toISOString()}&endDate=${now.toISOString()}`,
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
          );
          if (ctRes.ok) setChatToolStats(await ctRes.json());
        }
      } catch (ctErr) {
        console.error('Error fetching chat tool stats:', ctErr);
      }
    } catch (error) {
      console.error('Error fetching observability data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Mark/unmark a flagged call as reviewed. Persists to the backend (shared across all staff)
  // and optimistically updates local state so the tick flips instantly.
  const toggleReviewed = async (callId: string, next: boolean) => {
    const token = getSessionToken();
    if (!token) return;
    const optimistic = next ? { at: new Date().toISOString(), by: 'you' } : undefined;
    setCalls((prev) =>
      prev.map((c) =>
        c.id === callId ? ({ ...c, metrics: { ...(c.metrics as Record<string, unknown>), reviewed: optimistic } } as CallData) : c,
      ),
    );
    try {
      const res = await fetch(`/api/calls/${callId}/reviewed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: next }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setCalls((prev) =>
        prev.map((c) =>
          c.id === callId ? ({ ...c, metrics: { ...(c.metrics as Record<string, unknown>), reviewed: data.reviewed ?? undefined } } as CallData) : c,
        ),
      );
    } catch {
      // Revert on failure.
      setCalls((prev) =>
        prev.map((c) =>
          c.id === callId ? ({ ...c, metrics: { ...(c.metrics as Record<string, unknown>), reviewed: next ? undefined : { at: '', by: '' } } } as CallData) : c,
        ),
      );
    }
  };

  const aggregateStats = (callsData: CallData[]) => {
    const toolPerformance: AggregatedStats['toolPerformance'] = {};
    const errorMap = new Map<string, { count: number; message: string }>();
    let totalToolCalls = 0;
    let failedToolCalls = 0;
    let totalCallDuration = 0;
    let totalLlmLatency = 0;
    let llmLatencyCount = 0;
    let totalInterruptions = 0;

    // Registration metrics
    let callsWithRegLookup = 0;
    let callsWithMultipleAttempts = 0;
    let partialCaptureCount = 0;
    let notFoundCount = 0;
    let threeOrMoreAttemptsCount = 0;
    const issueCallsList: RegistrationIssueCall[] = [];

    // Booking abandonment metrics
    let bookingIntentCalls = 0;
    let completedBookings = 0;
    let abandonedBookings = 0;
    let noTimeslotsCount = 0;
    let costConcernCount = 0;
    let noMatchingServiceCount = 0;
    let humanRequestCount = 0;
    let otherReasonsCount = 0;
    const abandonmentCallsList: BookingAbandonmentCall[] = [];

    console.log(`[Booking Analysis] Processing ${callsData.length} calls for time range: ${timeRange}`);
    
    // Debug: Log first call structure to understand data format
    if (callsData.length > 0) {
      console.log('[Booking Analysis] Sample call structure:', {
        id: callsData[0].id,
        intent: callsData[0].intent,
        hasMetrics: !!callsData[0].metrics,
        metricsKeys: callsData[0].metrics ? Object.keys(callsData[0].metrics) : [],
        toolCalls: callsData[0].metrics?.tool_calls,
        sampleCall: callsData[0]
      });
    }

    const natoPhonetics = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 
                           'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 
                           'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 
                           'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];

    callsData.forEach((call) => {
      totalCallDuration += call.duration || 0;

      if (call.metrics?.avg_llm_latency_ms !== undefined) {
        totalLlmLatency += call.metrics.avg_llm_latency_ms;
        llmLatencyCount++;
      }

      totalInterruptions += getInterruptionCount(call);

      // Analyze registration attempts from transcript
      const transcript = call.transcript as any;
      let items: any[] = [];
      if (Array.isArray(transcript)) {
        items = transcript;
      } else if (transcript && typeof transcript === 'object') {
        items = Object.values(transcript);
      }

      if (items.length > 0) {
        // Count NATO phonetic readback attempts
        const readbackMessages = items.filter(
          (item: any) =>
            item.type === 'message' &&
            item.speaker === 'agent' &&
            item.text &&
            natoPhonetics.some(phonetic => item.text.includes(phonetic)) &&
            item.text.toLowerCase().includes('is that right')
        );

        // Count "not finding" messages
        const notFoundMessages = items.filter(
          (item: any) =>
            item.type === 'message' &&
            item.speaker === 'agent' &&
            item.text &&
            (item.text.toLowerCase().includes('not finding that') ||
             item.text.toLowerCase().includes("i'm having trouble finding") ||
             item.text.toLowerCase().includes('having trouble finding'))
        );

        const hasRegLookup = readbackMessages.length > 0;
        if (hasRegLookup) {
          callsWithRegLookup++;
          
          const attempts = readbackMessages.length;
          const hasNotFound = notFoundMessages.length > 0;
          
          if (attempts > 1 || hasNotFound) {
            callsWithMultipleAttempts++;
            
            if (hasNotFound) {
              notFoundCount++;
              issueCallsList.push({
                call,
                issueType: 'notFound',
                attempts,
                details: `Registration not found after ${attempts} attempt${attempts > 1 ? 's' : ''}`
              });
            }
            if (attempts >= 3) {
              threeOrMoreAttemptsCount++;
              issueCallsList.push({
                call,
                issueType: 'persistent',
                attempts,
                details: `Required ${attempts} readback attempts`
              });
            }
            
            // Check for partial capture (< 5 NATO phonetics in first readback)
            if (readbackMessages.length > 0) {
              const firstReadback = readbackMessages[0].text || '';
              const natoCount = natoPhonetics.filter(p => firstReadback.includes(p)).length;
              if (natoCount < 5) {
                partialCaptureCount++;
                issueCallsList.push({
                  call,
                  issueType: 'partial',
                  attempts,
                  details: `Only ${natoCount} characters captured initially`
                });
              }
            }
          }
        }
      }

      // Analyze booking intent from customer messages in transcript
      const callToolCalls = call.metrics?.tool_calls || [];
      const hasCreateJobAttempt = callToolCalls.some(tc => tc.tool_name === 'create_job');
      
      // Check customer messages for NEW booking intent (not cancellations/reschedules/updates)
      let hasBookingIntent = false;
      if (items.length > 0) {
        const customerMessages = items
          .filter((item: any) => item.type === 'message' && item.speaker === 'customer' && item.text)
          .map((item: any) => item.text.toLowerCase());
        
        const fullCustomerTranscript = customerMessages.join(' ');
        
        // Exclude cancellations, reschedules, and updates
        const isExcluded = 
          fullCustomerTranscript.includes('cancel') ||
          fullCustomerTranscript.includes('cancell') ||
          fullCustomerTranscript.includes('reschedule') ||
          fullCustomerTranscript.includes('re-schedule') ||
          fullCustomerTranscript.includes('rebook') ||
          fullCustomerTranscript.includes('re-book') ||
          fullCustomerTranscript.includes('change my booking') ||
          fullCustomerTranscript.includes('move my booking') ||
          fullCustomerTranscript.includes('update my booking') ||
          fullCustomerTranscript.includes('change my appointment') ||
          fullCustomerTranscript.includes('move my appointment');
        
        // Look for NEW booking phrases
        if (!isExcluded) {
          hasBookingIntent = 
            fullCustomerTranscript.includes('book an appointment') ||
            fullCustomerTranscript.includes('make an appointment') ||
            fullCustomerTranscript.includes('schedule an appointment') ||
            fullCustomerTranscript.includes('book a service') ||
            fullCustomerTranscript.includes('book my car') ||
            fullCustomerTranscript.includes('book in') ||
            fullCustomerTranscript.includes('bring my car in') ||
            fullCustomerTranscript.includes('bring the car in') ||
            fullCustomerTranscript.includes('get a service') ||
            fullCustomerTranscript.includes('need a service') ||
            fullCustomerTranscript.includes('book mot') ||
            fullCustomerTranscript.includes('book an mot') ||
            fullCustomerTranscript.includes('mot booking') ||
            fullCustomerTranscript.includes('need an mot') ||
            fullCustomerTranscript.includes('need mot') ||
            fullCustomerTranscript.includes('come in for') ||
            fullCustomerTranscript.includes('drop off') ||
            fullCustomerTranscript.includes('get it fixed') ||
            fullCustomerTranscript.includes('get it checked') ||
            fullCustomerTranscript.includes('need it looked at') ||
            fullCustomerTranscript.includes('looking to book') ||
            fullCustomerTranscript.includes('want to book') ||
            fullCustomerTranscript.includes('would like to book') ||
            fullCustomerTranscript.includes('can i book') ||
            hasCreateJobAttempt; // Also count if agent attempted to create booking
        }
      }
      
      if (hasBookingIntent) {
        bookingIntentCalls++;
        
        // Check if booking was completed
        // Look for submit_booking (final step) or create_job with success
        const submitBookingCalls = callToolCalls.filter(tc => tc.tool_name === 'submit_booking');
        const createJobCalls = callToolCalls.filter(tc => tc.tool_name === 'create_job');
        
        // A booking is successful if:
        // 1. submit_booking or create_job was called successfully, OR
        // 2. Transcript contains "BOOKING CONFIRMED" or "booked in"
        let hasSuccessfulBooking = 
          (submitBookingCalls.length > 0 && submitBookingCalls.some(tc => tc.success)) ||
          (createJobCalls.length > 0 && createJobCalls.some(tc => tc.success));
        
        // Also check transcript for booking confirmation phrases
        if (!hasSuccessfulBooking && items.length > 0) {
          const fullTranscript = items
            .filter((item: any) => item.type === 'message' || item.type === 'function_call_output')
            .map((item: any) => {
              if (item.output) return item.output.toLowerCase();
              if (item.text) return item.text.toLowerCase();
              if (item.content && Array.isArray(item.content)) return item.content.join(' ').toLowerCase();
              return '';
            })
            .join(' ');
          
          hasSuccessfulBooking = 
            fullTranscript.includes('booking confirmed') ||
            fullTranscript.includes('booked in') ||
            fullTranscript.includes('that\'s all booked');
        }
        
        console.log(`[Booking Intent] Call ${call.id}:`, {
          hasCreateJobAttempt,
          submitBookingCallsCount: submitBookingCalls.length,
          createJobCallsCount: createJobCalls.length,
          hasSuccessfulBooking,
          toolCallsSummary: callToolCalls.map(tc => ({ 
            name: tc.tool_name, 
            success: tc.success, 
            error: tc.error 
          })).filter(tc => tc.name === 'submit_booking' || tc.name === 'create_job')
        });
        
        if (hasSuccessfulBooking) {
          completedBookings++;
        } else {
          abandonedBookings++;
          
          // Analyze transcript for abandonment reason
          if (items.length > 0) {
            let reason: 'noTimeslots' | 'cost' | 'noMatchingService' | 'humanRequest' | 'other' = 'other';
            let details = 'Booking not completed';
            
            // Check for specific phrases in agent messages
            const agentMessages = items
              .filter((item: any) => item.type === 'message' && item.speaker === 'agent' && item.text)
              .map((item: any) => item.text.toLowerCase());
            
            const fullTranscript = agentMessages.join(' ');
            
            if (fullTranscript.includes('no available') || 
                fullTranscript.includes('no slots') ||
                fullTranscript.includes('fully booked') ||
                fullTranscript.includes('no appointments') ||
                fullTranscript.includes('no times available')) {
              reason = 'noTimeslots';
              details = 'No available time slots';
              noTimeslotsCount++;
            } else if (fullTranscript.includes('speak to someone') ||
                       fullTranscript.includes('talk to someone') ||
                       fullTranscript.includes('speak with someone') ||
                       fullTranscript.includes('talk with someone') ||
                       fullTranscript.includes('speak to a person') ||
                       fullTranscript.includes('talk to a person') ||
                       fullTranscript.includes('human') ||
                       fullTranscript.includes('real person') ||
                       fullTranscript.includes('actual person') ||
                       fullTranscript.includes('call me back') ||
                       fullTranscript.includes('ring me back')) {
              reason = 'humanRequest';
              details = 'Customer requested to speak to a human';
              humanRequestCount++;
            } else if (fullTranscript.includes('cost') || 
                       fullTranscript.includes('price') ||
                       fullTranscript.includes('expensive') ||
                       fullTranscript.includes('£') ||
                       fullTranscript.includes('pound')) {
              reason = 'cost';
              details = 'Customer concerned about cost';
              costConcernCount++;
            } else if (fullTranscript.includes('don\'t have that service') ||
                       fullTranscript.includes('not offer') ||
                       fullTranscript.includes('can\'t do that') ||
                       fullTranscript.includes('unable to help') ||
                       fullTranscript.includes('we don\'t')) {
              reason = 'noMatchingService';
              details = 'Service not offered';
              noMatchingServiceCount++;
            } else {
              otherReasonsCount++;
              details = 'Other reason or customer changed mind';
            }
            
            abandonmentCallsList.push({
              call,
              reason,
              details
            });
          }
        }
      }

      const toolCalls = call.metrics?.tool_calls || [];
      toolCalls.forEach((tc) => {
        totalToolCalls++;
        if (!tc.success) failedToolCalls++;

        if (!toolPerformance[tc.tool_name]) {
          toolPerformance[tc.tool_name] = { count: 0, successRate: 0, avgLatency: 0, errors: [] };
        }

        const tool = toolPerformance[tc.tool_name];
        tool.count++;
        if (tc.success) {
          tool.successRate = ((tool.successRate * (tool.count - 1)) + 1) / tool.count;
        } else {
          tool.successRate = (tool.successRate * (tool.count - 1)) / tool.count;
          if (tc.error_type) {
            const key = `${tc.tool_name}:${tc.error_type}`;
            const existing = errorMap.get(key);
            if (existing) existing.count++;
            else errorMap.set(key, { count: 1, message: tc.error || tc.error_type });
          }
        }
        tool.avgLatency = ((tool.avgLatency * (tool.count - 1)) + tc.duration_ms) / tool.count;
      });
    });

    const topErrors = Array.from(errorMap.entries())
      .map(([key, value]) => ({ type: key, count: value.count, message: value.message }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const firstAttemptSuccessRate = callsWithRegLookup > 0 
      ? ((callsWithRegLookup - callsWithMultipleAttempts) / callsWithRegLookup) * 100 
      : 0;
    const retryRate = callsWithRegLookup > 0 
      ? (callsWithMultipleAttempts / callsWithRegLookup) * 100 
      : 0;
    const conversionRate = bookingIntentCalls > 0
      ? (completedBookings / bookingIntentCalls) * 100
      : 0;

    console.log('[Booking Analysis] Final stats:', {
      bookingIntentCalls,
      completedBookings,
      abandonedBookings,
      conversionRate,
      abandonmentCallsListLength: abandonmentCallsList.length
    });

    setStats({
      totalCalls: callsData.length,
      avgCallDuration: callsData.length > 0 ? totalCallDuration / callsData.length : 0,
      totalToolCalls,
      failedToolCalls,
      avgLlmLatency: llmLatencyCount > 0 ? totalLlmLatency / llmLatencyCount : 0,
      avgInterruptions: callsData.length > 0 ? totalInterruptions / callsData.length : 0,
      toolPerformance,
      topErrors,
      registrationMetrics: {
        callsWithRegLookup,
        callsWithMultipleAttempts,
        firstAttemptSuccessRate,
        retryRate,
        partialCaptureCount,
        notFoundCount,
        threeOrMoreAttemptsCount,
      },
      bookingMetrics: {
        bookingIntentCalls,
        completedBookings,
        abandonedBookings,
        conversionRate,
        noTimeslotsCount,
        costConcernCount,
        noMatchingServiceCount,
        humanRequestCount,
        otherReasonsCount,
      },
    });
    setRegistrationIssueCalls(issueCallsList);
    setBookingAbandonmentCalls(abandonmentCallsList);
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getSuccessColor = (rate: number) => {
    if (rate >= 0.9) return 'text-emerald-700';
    if (rate >= 0.7) return 'text-amber-700';
    return 'text-rose-700';
  };

  const updateEvaluator = (
    key: keyof EvaluatorConfig,
    update: { enabled?: boolean; threshold?: number }
  ) => {
    setEvaluators((prev) => ({ ...prev, [key]: { ...prev[key], ...update } }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-slate-500">Loading observability data...</div>
      </div>
    );
  }

  const tabs = [
    { key: 'flagged' as const, label: 'Flagged Calls', badge: flaggedCalls.length, badgeColor: 'bg-rose-50 text-rose-300' },
    { key: 'tools' as const, label: 'Tool Performance', badge: 0, badgeColor: '' },
    { key: 'errors' as const, label: 'Error Analysis', badge: stats.topErrors.length, badgeColor: 'bg-slate-700 text-slate-500' },
    { key: 'registrations' as const, label: 'Registration Analysis', badge: stats.registrationMetrics.callsWithMultipleAttempts, badgeColor: 'bg-amber-50 text-amber-300' },
    { key: 'calls' as const, label: 'Recent Calls', badge: 0, badgeColor: '' },
  ];

  const _isStaff = isReceptionMateStaff();
  const _catLabel: Record<string, string> = {
    booking_failure: 'Booking failure', no_availability: 'No availability',
    reg_postcode_struggle: 'Reg/postcode struggle', misheard: 'Mis-heard value',
    dead_air: 'Dead air / slow', transfer_failed: 'Transfer failed',
    wrong_info: 'Wrong info', unresolved: 'Unresolved', other: 'Other',
  };
  const _flagged = _isStaff
    ? calls.filter((c) => ((c.metrics as Record<string, unknown> | undefined)?.['diagnosis'] as { status?: string } | undefined)?.status === 'issue')
    : [];
  const _catCounts: Record<string, number> = {};
  for (const c of _flagged) {
    const cat = String(((c.metrics as Record<string, unknown>)?.['diagnosis'] as { category?: string })?.category || 'other');
    _catCounts[cat] = (_catCounts[cat] || 0) + 1;
  }
  const _sortedCats = Object.entries(_catCounts).sort((a, b) => b[1] - a[1]);
  const _maxCat = _sortedCats.length ? _sortedCats[0][1] : 0;
  const _garageNames: Record<string, string> = {};
  for (const g of garageStats) _garageNames[g.garageId] = g.name;
  const _flaggedCat = (c: CallData) =>
    String(((c.metrics as Record<string, unknown>)?.['diagnosis'] as { category?: string })?.category || 'other');
  // Newest first, optionally narrowed to one failure type via the filter chips.
  const _flaggedList = [..._flagged]
    .filter((c) => !flaggedCategoryFilter || _flaggedCat(c) === flaggedCategoryFilter)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const _reviewedOf = (c: CallData) =>
    (c.metrics as Record<string, unknown> | undefined)?.['reviewed'] as { at?: string; by?: string } | undefined;
  const _reviewedCount = _flaggedList.filter((c) => _reviewedOf(c)).length;
  const _visibleFlagged = hideReviewed ? _flaggedList.filter((c) => !_reviewedOf(c)) : _flaggedList;

  return (
    <div className="space-y-6">
      {/* Time range — top of the page so it governs everything below. */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-500">Time Range:</label>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
          >
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="custom">Custom range…</option>
          </select>
        </div>
        {timeRange === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
            />
            <span className="text-sm text-slate-400">to</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
            />
          </div>
        )}
      </div>

      {_isStaff ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            AI-flagged calls
            <span className="rounded-full bg-rose-200 px-2 py-0.5 text-xs font-bold text-rose-800">{_flagged.length}</span>
            <span className="text-[11px] font-normal uppercase tracking-wide text-slate-400">staff only</span>
          </h2>
          <p className="text-xs text-slate-500">Calls the AI analyst flagged as a real failure {aggregateAllBranches ? 'across all branches' : 'for the selected branch'}, in the selected time range.</p>
          {_flagged.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No flagged calls in this period.</p>
          ) : (
            <div className="mt-4 space-y-4">
              {/* Filter chips — click a failure type to narrow the list, click again to clear. */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFlaggedCategoryFilter(null)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    flaggedCategoryFilter === null
                      ? 'border-rose-500 bg-rose-500 text-white'
                      : 'border-rose-200 bg-white text-slate-600 hover:border-rose-300'
                  }`}
                >
                  All <span className="ml-1 opacity-70">{_flagged.length}</span>
                </button>
                {_sortedCats.map(([cat, n]) => {
                  const active = flaggedCategoryFilter === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setFlaggedCategoryFilter(active ? null : cat)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        active
                          ? 'border-rose-500 bg-rose-500 text-white'
                          : 'border-rose-200 bg-white text-slate-600 hover:border-rose-300'
                      }`}
                    >
                      {_catLabel[cat] || cat} <span className="ml-1 opacity-70">{n}</span>
                    </button>
                  );
                })}
              </div>

              {/* Worklist — each row opens the call in a new tab so you keep your place. */}
              <div className="overflow-hidden rounded-lg border border-rose-100 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-rose-100 px-3 py-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <span className="text-emerald-600">{_reviewedCount}</span>/{_flaggedList.length} reviewed
                    {flaggedCategoryFilter ? ` · ${_catLabel[flaggedCategoryFilter] || flaggedCategoryFilter}` : ''}
                  </p>
                  <label className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-slate-500">
                    <input
                      type="checkbox"
                      checked={hideReviewed}
                      onChange={(e) => setHideReviewed(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 accent-emerald-500"
                    />
                    Hide reviewed
                  </label>
                </div>
                <ul className="max-h-[32rem] divide-y divide-rose-50 overflow-auto">
                  {_visibleFlagged.map((c) => {
                    const d = (c.metrics as Record<string, unknown>)?.['diagnosis'] as { headline?: string; detail?: string; category?: string; rootCause?: string; fix?: string; severity?: string } | undefined;
                    const branch = c.garageId ? (_garageNames[c.garageId] || c.garageId) : null;
                    const reviewed = _reviewedOf(c);
                    const isReviewed = Boolean(reviewed);
                    return (
                      <li key={c.id} className={`flex items-start gap-3 px-3 py-2.5 ${isReviewed ? 'bg-emerald-50/50' : 'hover:bg-rose-50'}`}>
                        <button
                          type="button"
                          onClick={() => toggleReviewed(c.id, !isReviewed)}
                          title={isReviewed ? `Reviewed${reviewed?.by ? ` by ${reviewed.by}` : ''} — click to unmark` : 'Mark as reviewed'}
                          aria-pressed={isReviewed}
                          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
                            isReviewed
                              ? 'border-emerald-500 bg-emerald-500 text-white'
                              : 'border-slate-300 bg-white text-transparent hover:border-emerald-400 hover:text-emerald-300'
                          }`}
                        >
                          ✓
                        </button>
                        <a
                          href={`/calls/${c.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-w-0 flex-1 items-start gap-3"
                        >
                          <span className="min-w-0 flex-1">
                            <span className={`block text-sm font-medium ${isReviewed ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{d?.headline || 'Issue'}</span>
                            {d?.detail && <span className="mt-0.5 block text-xs text-slate-500">{d.detail}</span>}
                            {d?.rootCause && (
                              <span className="mt-1 block text-xs text-slate-500"><span className="font-semibold text-slate-600">Root cause:</span> {d.rootCause}</span>
                            )}
                            {d?.fix && (
                              <span className="mt-0.5 block text-xs text-slate-500"><span className="font-semibold text-slate-600">Suggested fix:</span> {d.fix}</span>
                            )}
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                              <span className="rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700">{_catLabel[d?.category ?? ''] || d?.category || 'other'}</span>
                              {d?.severity && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">{d.severity}</span>}
                              {branch && <span className="font-medium text-slate-500">{branch}</span>}
                              <span>{new Date(c.createdAt).toLocaleString()}</span>
                              {c.customerPhone && <span className="font-mono">{c.customerPhone}</span>}
                              {c.duration > 0 && <span>{formatDuration(c.duration * 1000)}</span>}
                              {isReviewed && reviewed?.by && <span className="font-medium text-emerald-600">✓ {reviewed.by}</span>}
                            </span>
                          </span>
                          <span className="shrink-0 self-center text-xs font-semibold text-rose-600">View →</span>
                        </a>
                      </li>
                    );
                  })}
                  {_visibleFlagged.length === 0 && (
                    <li className="px-3 py-6 text-center text-sm text-emerald-700">All flagged calls reviewed 🎉</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {_isStaff && chatToolStats ? (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            Chat agent tool calls
            <span className="text-[11px] font-normal uppercase tracking-wide text-slate-400">staff only</span>
          </h2>
          <p className="text-xs text-slate-500">Web-chat agent tool-call health in the selected time range.</p>
          {chatToolStats.overall.total === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No chat tool calls in this period.</p>
          ) : (
            <div className="mt-4 space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Overall success</p>
                  <p className="text-2xl font-bold text-slate-900">{chatToolStats.overall.successRate}%</p>
                  <p className="text-[11px] text-slate-500">{chatToolStats.overall.success}/{chatToolStats.overall.total} calls · {chatToolStats.overall.failed} failed</p>
                </div>
                {chatToolStats.byAgent.map((a) => (
                  <div key={a.agentType} className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-400">{a.agentType}</p>
                    <p className={`text-2xl font-bold ${a.successRate >= 90 ? 'text-emerald-600' : a.successRate >= 70 ? 'text-amber-600' : 'text-rose-600'}`}>{a.successRate}%</p>
                    <p className="text-[11px] text-slate-500">{a.success}/{a.total} calls · {a.failed} failed</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By tool</p>
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <tr>
                          <th className="px-3 py-2">Tool</th>
                          <th className="px-3 py-2">Agent</th>
                          <th className="px-3 py-2 text-right">Calls</th>
                          <th className="px-3 py-2 text-right">Success</th>
                          <th className="px-3 py-2 text-right">Avg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chatToolStats.byTool.slice(0, 12).map((t) => (
                          <tr key={`${t.agentType}-${t.toolName}`} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 font-mono text-xs text-slate-800">{t.toolName}</td>
                            <td className="px-3 py-1.5 text-xs text-slate-500">{t.agentType}</td>
                            <td className="px-3 py-1.5 text-right text-slate-700">{t.total}</td>
                            <td className={`px-3 py-1.5 text-right font-semibold ${t.successRate >= 90 ? 'text-emerald-600' : t.successRate >= 70 ? 'text-amber-600' : 'text-rose-600'}`}>{t.successRate}%</td>
                            <td className="px-3 py-1.5 text-right text-slate-500">{t.avgMs}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent failures</p>
                  {chatToolStats.recentFailures.length === 0 ? (
                    <p className="text-sm text-slate-500">No failures in this period 🎉</p>
                  ) : (
                    <ul className="max-h-64 space-y-1 overflow-auto">
                      {chatToolStats.recentFailures.map((f) => (
                        <li key={f.id} title={`conversation ${f.conversationId}`}>
                          <div className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-white">
                            <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-rose-200 text-[10px] font-bold text-rose-800">✗</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-slate-800"><span className="font-mono text-xs">{f.toolName}</span> · {f.garageName} <span className="text-slate-400">({f.agentType})</span></span>
                              <span className="block truncate text-[11px] text-slate-400">{f.errorMessage || 'failed'} · {new Date(f.createdAt).toLocaleString()}</span>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Evaluator Configuration */}
      <div className="rounded-xl border border-amber-300 bg-amber-50 shadow-lg shadow-slate-900/5">
        <button
          onClick={() => setShowEvaluatorConfig((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-4"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-amber-300">Call Evaluators</span>
            {flaggedCalls.length > 0 && (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-300">
                {flaggedCalls.length} flagged
              </span>
            )}
          </div>
          <span className="text-xs text-slate-500">{showEvaluatorConfig ? '▲ collapse' : '▼ configure'}</span>
        </button>

        {showEvaluatorConfig && (
          <div className="grid gap-4 border-t border-amber-300 px-5 py-4 sm:grid-cols-3">
            {/* High LLM Latency */}
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="eval-latency"
                checked={evaluators.highLatency.enabled}
                onChange={(e) => updateEvaluator('highLatency', { enabled: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-amber-400"
              />
              <label htmlFor="eval-latency" className="flex-1 text-sm text-slate-600">
                <span className="block font-medium">High LLM Latency</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highLatency.threshold}
                    onChange={(e) => updateEvaluator('highLatency', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highLatency.enabled}
                    className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-500">ms</span>
                </div>
              </label>
            </div>

            {/* High Interruptions */}
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="eval-interruptions"
                checked={evaluators.highInterruptions.enabled}
                onChange={(e) => updateEvaluator('highInterruptions', { enabled: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-amber-400"
              />
              <label htmlFor="eval-interruptions" className="flex-1 text-sm text-slate-600">
                <span className="block font-medium">High Interruptions</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highInterruptions.threshold}
                    onChange={(e) => updateEvaluator('highInterruptions', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highInterruptions.enabled}
                    className="w-16 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-500">per call</span>
                </div>
              </label>
            </div>

            {/* Tool Failure Rate */}
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="eval-failrate"
                checked={evaluators.highFailureRate.enabled}
                onChange={(e) => updateEvaluator('highFailureRate', { enabled: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-amber-400"
              />
              <label htmlFor="eval-failrate" className="flex-1 text-sm text-slate-600">
                <span className="block font-medium">Tool Failure Rate</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highFailureRate.threshold}
                    onChange={(e) => updateEvaluator('highFailureRate', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highFailureRate.enabled}
                    className="w-16 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-500">%</span>
                </div>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total Calls</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{stats.totalCalls}</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Avg Duration</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">
            {formatDuration(stats.avgCallDuration * 1000)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Tool Calls</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{stats.totalToolCalls}</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Failed Tools</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-rose-700">{stats.failedToolCalls}</span>
            {stats.totalToolCalls > 0 && (
              <span className="text-sm text-slate-500">
                ({((stats.failedToolCalls / stats.totalToolCalls) * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Avg LLM Latency</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">
            {stats.avgLlmLatency > 0 ? formatDuration(stats.avgLlmLatency) : '—'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
          <div className="text-xs uppercase tracking-wide text-slate-500">Avg Interruptions</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">
            {stats.avgInterruptions > 0 ? stats.avgInterruptions.toFixed(1) : '—'}
          </div>
        </div>
      </div>

      {/* Branch leaderboard — staff mini-dashboard ranking every garage */}
      {garageStats.length > 0 && (() => {
        const metricMeta: Record<typeof garageStatMetric, { label: string; format: (n: number) => string }> = {
          callCount: { label: 'Calls', format: (n) => n.toLocaleString() },
          bookingCount: { label: 'Bookings', format: (n) => n.toLocaleString() },
          totalDurationSeconds: {
            label: 'Minutes used',
            format: (n) => `${Math.round(n / 60).toLocaleString()} min`,
          },
          capturedRevenue: { label: 'Revenue', format: (n) => `£${Math.round(n).toLocaleString()}` },
        };
        const ranked = [...garageStats].sort((a, b) => b[garageStatMetric] - a[garageStatMetric]);
        const max = ranked[0]?.[garageStatMetric] || 1;
        const totals = garageStats.reduce(
          (acc, g) => ({
            callCount: acc.callCount + g.callCount,
            bookingCount: acc.bookingCount + g.bookingCount,
            totalDurationSeconds: acc.totalDurationSeconds + g.totalDurationSeconds,
            capturedRevenue: acc.capturedRevenue + g.capturedRevenue,
          }),
          { callCount: 0, bookingCount: 0, totalDurationSeconds: 0, capturedRevenue: 0 },
        );
        return (
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-900/5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Branch leaderboard</h2>
                <p className="text-sm text-slate-500">
                  {garageStats.length} active branches · {totals.callCount.toLocaleString()} calls ·{' '}
                  {totals.bookingCount.toLocaleString()} bookings ·{' '}
                  {Math.round(totals.totalDurationSeconds / 60).toLocaleString()} min ·{' '}
                  £{Math.round(totals.capturedRevenue).toLocaleString()} revenue
                </p>
              </div>
              <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
                {(Object.keys(metricMeta) as (typeof garageStatMetric)[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => setGarageStatMetric(key)}
                    className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                      garageStatMetric === key
                        ? 'bg-white text-brand-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {metricMeta[key].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {ranked.map((g, idx) => (
                <button
                  key={g.garageId}
                  type="button"
                  onClick={() => {
                    // Switch the active branch then open its dashboard (AppShell re-reads on load).
                    setGarageId(g.garageId);
                    window.location.href = '/dashboard';
                  }}
                  className="group flex w-full items-center gap-3"
                  title={`Garage ID: ${g.garageId} — open dashboard`}
                >
                  <span className="w-6 shrink-0 text-right text-xs font-semibold text-slate-400">
                    {idx + 1}
                  </span>
                  <div className="relative h-8 flex-1 overflow-hidden rounded-md bg-slate-100">
                    <div
                      className="absolute inset-y-0 left-0 rounded-md bg-brand-100 transition-all group-hover:bg-brand-200"
                      style={{ width: `${Math.max(2, (g[garageStatMetric] / max) * 100)}%` }}
                    />
                    <div className="absolute inset-0 flex items-center justify-between px-3">
                      <span className="truncate text-sm font-medium text-slate-700">{g.name}</span>
                      <span className="ml-2 shrink-0 text-sm font-semibold text-slate-900">
                        {metricMeta[garageStatMetric].format(g[garageStatMetric])}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5">
        <div className="flex border-b border-slate-200">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-b-2 border-brand-600 text-brand-600'
                  : 'text-slate-500 hover:text-slate-600'
              }`}
            >
              {tab.label}
              {tab.badge > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${tab.badgeColor}`}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="p-6">
          {/* Flagged Calls Tab */}
          {activeTab === 'flagged' && (
            <div className="space-y-3">
              {flaggedCalls.length === 0 ? (
                <div className="py-8 text-center text-emerald-700">
                  No calls flagged by current evaluators
                </div>
              ) : (
                flaggedCalls.map(({ call, reasons }) => {
                  const toolCalls = call.metrics?.tool_calls || [];
                  const interruptions = getInterruptionCount(call);
                  return (
                    <div
                      key={call.id}
                      className="rounded-lg border border-rose-300 bg-rose-50 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                            <span>{new Date(call.createdAt).toLocaleString()}</span>
                            {call.customerPhone && (
                              <span className="font-mono text-slate-600">{call.customerPhone}</span>
                            )}
                            {call.intent && (
                              <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-600">
                                {call.intent}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {reasons.map((reason, i) => (
                              <span
                                key={i}
                                className="rounded-full bg-rose-50 px-2 py-1 text-xs text-rose-300"
                              >
                                {reason}
                              </span>
                            ))}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span>Duration: {formatDuration(call.duration * 1000)}</span>
                            {(call.metrics?.avg_llm_latency_ms ?? 0) > 0 && (
                              <span>LLM: {formatDuration(call.metrics!.avg_llm_latency_ms!)}</span>
                            )}
                            {interruptions > 0 && <span>Interruptions: {interruptions}</span>}
                            <span>Tools: {toolCalls.length}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Tool Performance Tab */}
          {activeTab === 'tools' && (
            <div className="space-y-4">
              {Object.keys(stats.toolPerformance).length === 0 ? (
                <div className="py-8 text-center text-slate-500">
                  No tool usage data available for this time range
                </div>
              ) : (
                Object.entries(stats.toolPerformance)
                  .sort(([, a], [, b]) => b.count - a.count)
                  .map(([toolName, tool]) => (
                    <div
                      key={toolName}
                      className="rounded-lg border border-slate-300 bg-white p-4"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h3 className="font-semibold text-slate-900">{toolName}</h3>
                          <div className="mt-2 flex flex-wrap gap-4 text-sm">
                            <div>
                              <span className="text-slate-500">Calls: </span>
                              <span className="font-medium text-slate-700">{tool.count}</span>
                            </div>
                            <div>
                              <span className="text-slate-500">Success Rate: </span>
                              <span className={`font-medium ${getSuccessColor(tool.successRate)}`}>
                                {(tool.successRate * 100).toFixed(1)}%
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500">Avg Latency: </span>
                              <span className="font-medium text-slate-700">
                                {formatDuration(tool.avgLatency)}
                              </span>
                            </div>
                          </div>
                        </div>
                        {tool.successRate < 0.9 && (
                          <span className="rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">
                            Needs Attention
                          </span>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>
          )}

          {/* Error Analysis Tab */}
          {activeTab === 'errors' && (
            <div className="space-y-3">
              {stats.topErrors.length === 0 ? (
                <div className="py-8 text-center text-emerald-700">
                  No errors detected in this time range
                </div>
              ) : (
                stats.topErrors.map((error, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-rose-300 bg-rose-50 p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="font-mono text-sm text-rose-700">{error.type}</div>
                        <div className="mt-1 text-sm text-slate-600">{error.message}</div>
                      </div>
                      <span className="rounded-full bg-rose-50 px-3 py-1 text-sm font-semibold text-rose-300">
                        {error.count}x
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Registration Analysis Tab */}
          {activeTab === 'registrations' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">Estimated from call transcripts — registration capture is inferred from the conversation (phonetic readbacks, retries, "not finding that"), so treat these as indicative trends rather than exact figures.</p>
              {/* Summary Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-300 bg-white p-4">
                  <div className="text-sm text-slate-500">Calls with Registration</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {stats.registrationMetrics.callsWithRegLookup}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.totalCalls > 0 ? ((stats.registrationMetrics.callsWithRegLookup / stats.totalCalls) * 100).toFixed(1) : '0.0'}% of total calls
                  </div>
                </div>

                <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
                  <div className="text-sm text-slate-500">First-Attempt Success</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-700">
                    {stats.registrationMetrics.firstAttemptSuccessRate.toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.registrationMetrics.callsWithRegLookup - stats.registrationMetrics.callsWithMultipleAttempts} successful on first try
                  </div>
                </div>

                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                  <div className="text-sm text-slate-500">Retry Rate</div>
                  <div className="mt-1 text-2xl font-bold text-amber-700">
                    {stats.registrationMetrics.retryRate.toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.registrationMetrics.callsWithMultipleAttempts} calls needed multiple attempts
                  </div>
                </div>

                <div className="rounded-lg border border-rose-300 bg-rose-50 p-4">
                  <div className="text-sm text-slate-500">3+ Attempts</div>
                  <div className="mt-1 text-2xl font-bold text-rose-700">
                    {stats.registrationMetrics.threeOrMoreAttemptsCount}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Calls requiring 3 or more tries
                  </div>
                </div>
              </div>

              {/* Common Issues Breakdown */}
              {stats.registrationMetrics.callsWithMultipleAttempts > 0 && (
                <div className="rounded-lg border border-slate-300 bg-white p-6">
                  <h3 className="mb-4 text-lg font-semibold text-slate-900">Common Issues</h3>
                  <div className="space-y-3">
                    {/* Partial Capture Card */}
                    <div>
                      <button
                        onClick={() => setExpandedIssueType(expandedIssueType === 'partial' ? null : 'partial')}
                        className="w-full flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-4 transition-all hover:bg-amber-50 hover:border-amber-300 cursor-pointer"
                      >
                        <div className="flex-1 text-left">
                          <div className="font-medium text-amber-300">Partial Capture</div>
                          <div className="mt-1 text-sm text-slate-500">
                            Less than 5 characters captured on first attempt
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="text-2xl font-bold text-amber-700">
                              {stats.registrationMetrics.partialCaptureCount}
                            </div>
                            <div className="text-xs text-slate-500">
                              {stats.registrationMetrics.callsWithMultipleAttempts > 0 
                                ? ((stats.registrationMetrics.partialCaptureCount / stats.registrationMetrics.callsWithMultipleAttempts) * 100).toFixed(1) 
                                : '0.0'}%
                            </div>
                          </div>
                          <svg 
                            className={`w-5 h-5 text-amber-700 transition-transform ${expandedIssueType === 'partial' ? 'rotate-180' : ''}`} 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expandedIssueType === 'partial' && (
                        <div className="mt-2 space-y-2 pl-4">
                          {registrationIssueCalls
                            .filter(issue => issue.issueType === 'partial')
                            .map((issue, idx) => (
                              <div key={idx} className="rounded border border-amber-300 bg-white p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-600">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-500">
                                        {issue.call.customerPhone}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-amber-700">
                                      {issue.details}
                                    </div>
                                  </div>
                                  <a
                                    href={`/calls/${issue.call.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-300 hover:bg-amber-50"
                                  >
                                    View Call →
                                  </a>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>

                    {/* Not Finding Card */}
                    <div>
                      <button
                        onClick={() => setExpandedIssueType(expandedIssueType === 'notFound' ? null : 'notFound')}
                        className="w-full flex items-center justify-between rounded-lg border border-rose-300 bg-rose-50 p-4 transition-all hover:bg-rose-50 hover:border-rose-300 cursor-pointer"
                      >
                        <div className="flex-1 text-left">
                          <div className="font-medium text-rose-300">"Not Finding" Errors</div>
                          <div className="mt-1 text-sm text-slate-500">
                            Registration not found in Garage Hive system
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="text-2xl font-bold text-rose-700">
                              {stats.registrationMetrics.notFoundCount}
                            </div>
                            <div className="text-xs text-slate-500">
                              {stats.registrationMetrics.callsWithMultipleAttempts > 0 
                                ? ((stats.registrationMetrics.notFoundCount / stats.registrationMetrics.callsWithMultipleAttempts) * 100).toFixed(1) 
                                : '0.0'}%
                            </div>
                          </div>
                          <svg 
                            className={`w-5 h-5 text-rose-700 transition-transform ${expandedIssueType === 'notFound' ? 'rotate-180' : ''}`} 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expandedIssueType === 'notFound' && (
                        <div className="mt-2 space-y-2 pl-4">
                          {registrationIssueCalls
                            .filter(issue => issue.issueType === 'notFound')
                            .map((issue, idx) => (
                              <div key={idx} className="rounded border border-rose-300 bg-white p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-600">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-500">
                                        {issue.call.customerPhone}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-rose-700">
                                      {issue.details}
                                    </div>
                                  </div>
                                  <a
                                    href={`/calls/${issue.call.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-3 rounded bg-rose-50 px-2 py-1 text-xs text-rose-300 hover:bg-rose-50"
                                  >
                                    View Call →
                                  </a>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>

                    {/* Persistent Issues Card */}
                    <div>
                      <button
                        onClick={() => setExpandedIssueType(expandedIssueType === 'persistent' ? null : 'persistent')}
                        className="w-full flex items-center justify-between rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 transition-all hover:bg-purple-500/10 hover:border-purple-500/30 cursor-pointer"
                      >
                        <div className="flex-1 text-left">
                          <div className="font-medium text-purple-300">Persistent Issues</div>
                          <div className="mt-1 text-sm text-slate-500">
                            Required 3 or more readback attempts
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="text-2xl font-bold text-purple-400">
                              {stats.registrationMetrics.threeOrMoreAttemptsCount}
                            </div>
                            <div className="text-xs text-slate-500">
                              {stats.registrationMetrics.callsWithMultipleAttempts > 0 
                                ? ((stats.registrationMetrics.threeOrMoreAttemptsCount / stats.registrationMetrics.callsWithMultipleAttempts) * 100).toFixed(1) 
                                : '0.0'}%
                            </div>
                          </div>
                          <svg 
                            className={`w-5 h-5 text-purple-400 transition-transform ${expandedIssueType === 'persistent' ? 'rotate-180' : ''}`} 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expandedIssueType === 'persistent' && (
                        <div className="mt-2 space-y-2 pl-4">
                          {registrationIssueCalls
                            .filter(issue => issue.issueType === 'persistent')
                            .map((issue, idx) => (
                              <div key={idx} className="rounded border border-purple-500/20 bg-white p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-600">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-500">
                                        {issue.call.customerPhone}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-purple-400">
                                      {issue.details}
                                    </div>
                                  </div>
                                  <a
                                    href={`/calls/${issue.call.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-3 rounded bg-purple-500/20 px-2 py-1 text-xs text-purple-300 hover:bg-purple-500/30"
                                  >
                                    View Call →
                                  </a>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Insights */}
              {stats.registrationMetrics.callsWithRegLookup > 0 && (
                <div className="rounded-lg border border-slate-300 bg-white p-6">
                  <h3 className="mb-3 text-lg font-semibold text-slate-900">Analysis Insights</h3>
                  <div className="space-y-2 text-sm text-slate-600">
                    {stats.registrationMetrics.retryRate > 50 && (
                      <div className="flex items-start gap-2">
                        <span className="text-amber-700">⚠️</span>
                        <span>
                          High retry rate ({stats.registrationMetrics.retryRate.toFixed(1)}%) indicates potential issues with registration capture. Common causes include background noise, unclear speech, or S/C confusion.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.firstAttemptSuccessRate > 70 && (
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-700">✓</span>
                        <span>
                          Strong first-attempt success rate ({stats.registrationMetrics.firstAttemptSuccessRate.toFixed(1)}%) shows effective initial capture in most cases.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.partialCaptureCount > stats.registrationMetrics.callsWithMultipleAttempts * 0.3 && (
                      <div className="flex items-start gap-2">
                        <span className="text-amber-700">💡</span>
                        <span>
                          Partial captures are a significant issue. Consider improving prompts to encourage customers to spell out complete registrations.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.notFoundCount > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-slate-500">ℹ️</span>
                        <span>
                          {stats.registrationMetrics.notFoundCount} registration(s) not found in system may indicate new customers or incorrect spelling.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {stats.registrationMetrics.callsWithRegLookup === 0 && (
                <div className="py-8 text-center text-slate-500">
                  No registration lookups in this time range
                </div>
              )}

              {/* Booking Abandonment Analysis */}
              {stats.bookingMetrics.bookingIntentCalls > 0 && (
                <>
                  <div className="mt-6 border-t border-slate-300 pt-6">
                    <h2 className="mb-1 text-xl font-bold text-slate-900">Booking Analysis</h2>
                    <p className="mb-4 text-xs text-slate-500">Estimated from call transcripts — booking intent, completion and abandonment reasons are inferred from what was said, so treat these as indicative trends rather than exact figures.</p>
                  </div>

                  {/* Booking Summary Cards */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border border-slate-300 bg-white p-4">
                      <div className="text-sm text-slate-500">Booking Intent Calls</div>
                      <div className="mt-1 text-2xl font-bold text-slate-900">
                        {stats.bookingMetrics.bookingIntentCalls}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Customers wanted to book
                      </div>
                    </div>

                    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
                      <div className="text-sm text-slate-500">Completed Bookings</div>
                      <div className="mt-1 text-2xl font-bold text-emerald-700">
                        {stats.bookingMetrics.completedBookings}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Successfully created jobs
                      </div>
                    </div>

                    <div className="rounded-lg border border-rose-300 bg-rose-50 p-4">
                      <div className="text-sm text-slate-500">Abandoned Bookings</div>
                      <div className="mt-1 text-2xl font-bold text-rose-700">
                        {stats.bookingMetrics.abandonedBookings}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Intent but no booking created
                      </div>
                    </div>

                    <div className={`rounded-lg border p-4 ${
                      stats.bookingMetrics.conversionRate >= 70 
                        ? 'border-emerald-300 bg-emerald-50' 
                        : stats.bookingMetrics.conversionRate >= 50
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-rose-300 bg-rose-50'
                    }`}>
                      <div className="text-sm text-slate-500">Conversion Rate</div>
                      <div className={`mt-1 text-2xl font-bold ${
                        stats.bookingMetrics.conversionRate >= 70 
                          ? 'text-emerald-700' 
                          : stats.bookingMetrics.conversionRate >= 50
                          ? 'text-amber-700'
                          : 'text-rose-700'
                      }`}>
                        {stats.bookingMetrics.conversionRate.toFixed(1)}%
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Intent to completed booking
                      </div>
                    </div>
                  </div>

                  {/* Abandonment Reasons */}
                  {stats.bookingMetrics.abandonedBookings > 0 && (
                    <div className="rounded-lg border border-slate-300 bg-white p-6">
                      <h3 className="mb-4 text-lg font-semibold text-slate-900">Abandonment Reasons</h3>
                      <div className="space-y-3">
                        {/* No Timeslots */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'noTimeslots' ? null : 'noTimeslots')}
                            className="w-full flex items-center justify-between rounded-lg border border-orange-500/20 bg-orange-500/5 p-4 transition-all hover:bg-orange-500/10 hover:border-orange-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-orange-300">No Available Timeslots</div>
                              <div className="mt-1 text-sm text-slate-500">
                                Customer couldn't find suitable appointment time
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-orange-400">
                                  {stats.bookingMetrics.noTimeslotsCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.noTimeslotsCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-orange-400 transition-transform ${expandedAbandonmentReason === 'noTimeslots' ? 'rotate-180' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedAbandonmentReason === 'noTimeslots' && (
                            <div className="mt-2 space-y-2 pl-4">
                              {bookingAbandonmentCalls
                                .filter(abandonment => abandonment.reason === 'noTimeslots')
                                .map((abandonment, idx) => (
                                  <div key={idx} className="rounded border border-orange-500/20 bg-white p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-600">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-500">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-orange-400">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-orange-500/20 px-2 py-1 text-xs text-orange-300 hover:bg-orange-500/30"
                                      >
                                        View Call →
                                      </a>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>

                        {/* Human Request */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'humanRequest' ? null : 'humanRequest')}
                            className="w-full flex items-center justify-between rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 transition-all hover:bg-purple-500/10 hover:border-purple-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-purple-300">Human Request</div>
                              <div className="mt-1 text-sm text-slate-500">
                                Customer requested to speak to a human
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-purple-400">
                                  {stats.bookingMetrics.humanRequestCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.humanRequestCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-purple-400 transition-transform ${expandedAbandonmentReason === 'humanRequest' ? 'rotate-180' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedAbandonmentReason === 'humanRequest' && (
                            <div className="mt-2 space-y-2 pl-4">
                              {bookingAbandonmentCalls
                                .filter(abandonment => abandonment.reason === 'humanRequest')
                                .map((abandonment, idx) => (
                                  <div key={idx} className="rounded border border-purple-500/20 bg-white p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-600">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-500">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-purple-400">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-purple-500/20 px-2 py-1 text-xs text-purple-300 hover:bg-purple-500/30"
                                      >
                                        View Call →
                                      </a>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>

                        {/* Cost Concern */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'cost' ? null : 'cost')}
                            className="w-full flex items-center justify-between rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 transition-all hover:bg-yellow-500/10 hover:border-yellow-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-yellow-300">Cost Concerns</div>
                              <div className="mt-1 text-sm text-slate-500">
                                Customer concerned about pricing
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-yellow-400">
                                  {stats.bookingMetrics.costConcernCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.costConcernCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-yellow-400 transition-transform ${expandedAbandonmentReason === 'cost' ? 'rotate-180' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedAbandonmentReason === 'cost' && (
                            <div className="mt-2 space-y-2 pl-4">
                              {bookingAbandonmentCalls
                                .filter(abandonment => abandonment.reason === 'cost')
                                .map((abandonment, idx) => (
                                  <div key={idx} className="rounded border border-yellow-500/20 bg-white p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-600">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-500">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-yellow-400">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-300 hover:bg-yellow-500/30"
                                      >
                                        View Call →
                                      </a>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>

                        {/* No Matching Service */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'noMatchingService' ? null : 'noMatchingService')}
                            className="w-full flex items-center justify-between rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 transition-all hover:bg-blue-500/10 hover:border-blue-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-blue-300">No Matching Service</div>
                              <div className="mt-1 text-sm text-slate-500">
                                Service not offered or available
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-blue-400">
                                  {stats.bookingMetrics.noMatchingServiceCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.noMatchingServiceCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-blue-400 transition-transform ${expandedAbandonmentReason === 'noMatchingService' ? 'rotate-180' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedAbandonmentReason === 'noMatchingService' && (
                            <div className="mt-2 space-y-2 pl-4">
                              {bookingAbandonmentCalls
                                .filter(abandonment => abandonment.reason === 'noMatchingService')
                                .map((abandonment, idx) => (
                                  <div key={idx} className="rounded border border-blue-500/20 bg-white p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-600">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-500">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-blue-400">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-blue-500/20 px-2 py-1 text-xs text-blue-300 hover:bg-blue-500/30"
                                      >
                                        View Call →
                                      </a>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>

                        {/* Other Reasons */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'other' ? null : 'other')}
                            className="w-full flex items-center justify-between rounded-lg border border-slate-500/20 bg-slate-500/5 p-4 transition-all hover:bg-slate-500/10 hover:border-slate-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-slate-600">Other Reasons</div>
                              <div className="mt-1 text-sm text-slate-500">
                                Customer changed mind or other factors
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-slate-500">
                                  {stats.bookingMetrics.otherReasonsCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.otherReasonsCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-slate-500 transition-transform ${expandedAbandonmentReason === 'other' ? 'rotate-180' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>
                          {expandedAbandonmentReason === 'other' && (
                            <div className="mt-2 space-y-2 pl-4">
                              {bookingAbandonmentCalls
                                .filter(abandonment => abandonment.reason === 'other')
                                .map((abandonment, idx) => (
                                  <div key={idx} className="rounded border border-slate-500/20 bg-white p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-600">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-500">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-slate-500">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-slate-500/20 px-2 py-1 text-xs text-slate-600 hover:bg-slate-500/30"
                                      >
                                        View Call →
                                      </a>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Booking Insights */}
                  <div className="rounded-lg border border-slate-300 bg-white p-6">
                    <h3 className="mb-3 text-lg font-semibold text-slate-900">Booking Insights</h3>
                    <div className="space-y-2 text-sm text-slate-600">
                      {stats.bookingMetrics.conversionRate < 50 && (
                        <div className="flex items-start gap-2">
                          <span className="text-rose-700">⚠️</span>
                          <span>
                            Low conversion rate ({stats.bookingMetrics.conversionRate.toFixed(1)}%) - Only {stats.bookingMetrics.completedBookings} of {stats.bookingMetrics.bookingIntentCalls} booking intents converted to actual bookings.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.conversionRate >= 70 && (
                        <div className="flex items-start gap-2">
                          <span className="text-emerald-700">✓</span>
                          <span>
                            Excellent conversion rate ({stats.bookingMetrics.conversionRate.toFixed(1)}%) - {stats.bookingMetrics.completedBookings} bookings from {stats.bookingMetrics.bookingIntentCalls} calls with booking intent.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.noTimeslotsCount > stats.bookingMetrics.abandonedBookings * 0.3 && (
                        <div className="flex items-start gap-2">
                          <span className="text-amber-700">💡</span>
                          <span>
                            Timeslot availability is a significant issue ({stats.bookingMetrics.noTimeslotsCount} calls). Consider expanding available appointment times or improving scheduling flexibility.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.costConcernCount > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-slate-500">ℹ️</span>
                          <span>
                            {stats.bookingMetrics.costConcernCount} customer(s) mentioned cost concerns. Review pricing communication strategy.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.noMatchingServiceCount > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-slate-500">ℹ️</span>
                          <span>
                            {stats.bookingMetrics.noMatchingServiceCount} call(s) couldn't find matching service. Consider expanding service offerings or improving service discovery.
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Recent Calls Tab */}
          {activeTab === 'calls' && (
            <div className="space-y-3">
              {calls.slice(0, 20).map((call) => {
                const toolCalls = call.metrics?.tool_calls || [];
                const hasErrors = toolCalls.some((tc) => !tc.success);
                const interruptions = getInterruptionCount(call);

                return (
                  <div
                    key={call.id}
                    className={`rounded-lg border p-4 ${
                      hasErrors
                        ? 'border-rose-300 bg-rose-50'
                        : 'border-slate-300 bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="text-sm text-slate-500">
                          {new Date(call.createdAt).toLocaleString()}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-3 text-sm">
                          <div>
                            <span className="text-slate-500">Duration: </span>
                            <span className="text-slate-700">{formatDuration(call.duration * 1000)}</span>
                          </div>
                          {call.intent && (
                            <div>
                              <span className="text-slate-500">Intent: </span>
                              <span className="text-slate-700">{call.intent}</span>
                            </div>
                          )}
                          {(call.metrics?.avg_llm_latency_ms ?? 0) > 0 && (
                            <div>
                              <span className="text-slate-500">LLM Latency: </span>
                              <span className="text-slate-700">
                                {formatDuration(call.metrics!.avg_llm_latency_ms!)}
                              </span>
                            </div>
                          )}
                          {interruptions > 0 && (
                            <div>
                              <span className="text-slate-500">Interruptions: </span>
                              <span className="text-slate-700">{interruptions}</span>
                            </div>
                          )}
                          <div>
                            <span className="text-slate-500">Tools: </span>
                            <span className="text-slate-700">{toolCalls.length}</span>
                          </div>
                        </div>
                        {toolCalls.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {toolCalls.map((tc, idx) => (
                              <span
                                key={idx}
                                className={`rounded-full px-2 py-1 text-xs font-medium ${
                                  tc.success
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-rose-50 text-rose-700'
                                }`}
                              >
                                {tc.tool_name} ({formatDuration(tc.duration_ms)})
                                {!tc.success && ' x'}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

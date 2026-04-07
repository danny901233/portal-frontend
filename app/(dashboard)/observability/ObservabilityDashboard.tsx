'use client';

import { useEffect, useState } from 'react';
import { getGarageId, getSessionToken } from '../../lib/auth';

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

// --- Constants ---

const DEFAULT_EVALUATORS: EvaluatorConfig = {
  highLatency: { enabled: true, threshold: 3000 },
  highInterruptions: { enabled: true, threshold: 3 },
  highFailureRate: { enabled: true, threshold: 20 },
};

const EVALUATORS_STORAGE_KEY = 'rm_evaluator_config';
const FLAGGED_NOTIFIED_KEY  = 'rm_flagged_notified';

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
  const [timeRange, setTimeRange] = useState('24h');
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
    const flagged = computeFlaggedCalls(calls, evaluators);
    setFlaggedCalls(flagged);

    // Notify Discord for newly flagged calls (deduplicated via localStorage)
    const token = getSessionToken();
    if (!token || flagged.length === 0) return;
    let notified: string[] = [];
    try { notified = JSON.parse(localStorage.getItem(FLAGGED_NOTIFIED_KEY) || '[]'); } catch {}
    const newlyFlagged = flagged.filter((f) => !notified.includes(f.call.id));
    if (newlyFlagged.length === 0) return;
    const garageId = getGarageId() || 'unknown';
    newlyFlagged.forEach(({ call, reasons }) => {
      fetch('/api/calls/report-flagged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ callId: call.id, garageName: garageId, reasons }),
      }).catch(() => {});
    });
    const updatedNotified = [...notified, ...newlyFlagged.map((f) => f.call.id)].slice(-200);
    try { localStorage.setItem(FLAGGED_NOTIFIED_KEY, JSON.stringify(updatedNotified)); } catch {}
  }, [evaluators, calls]);

  useEffect(() => {
    fetchData();
  }, [timeRange]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const garageId = getGarageId() || 'any';
      const token = getSessionToken();

      if (!token) {
        console.error('No session token found');
        return;
      }

      const now = new Date();
      const startDate = new Date();
      if (timeRange === '24h') startDate.setHours(now.getHours() - 24);
      else if (timeRange === '7d') startDate.setDate(now.getDate() - 7);
      else if (timeRange === '30d') startDate.setDate(now.getDate() - 30);

      const response = await fetch(
        `/api/garages/${garageId}/calls?startDate=${startDate.toISOString()}&endDate=${now.toISOString()}`,
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
    } catch (error) {
      console.error('Error fetching observability data:', error);
    } finally {
      setLoading(false);
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
    if (rate >= 0.9) return 'text-emerald-400';
    if (rate >= 0.7) return 'text-amber-400';
    return 'text-rose-400';
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
        <div className="text-slate-400">Loading observability data...</div>
      </div>
    );
  }

  const tabs = [
    { key: 'flagged' as const, label: 'Flagged Calls', badge: flaggedCalls.length, badgeColor: 'bg-rose-500/20 text-rose-300' },
    { key: 'tools' as const, label: 'Tool Performance', badge: 0, badgeColor: '' },
    { key: 'errors' as const, label: 'Error Analysis', badge: stats.topErrors.length, badgeColor: 'bg-slate-700 text-slate-400' },
    { key: 'registrations' as const, label: 'Registration Analysis', badge: stats.registrationMetrics.callsWithMultipleAttempts, badgeColor: 'bg-amber-500/20 text-amber-300' },
    { key: 'calls' as const, label: 'Recent Calls', badge: 0, badgeColor: '' },
  ];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-400">Time Range:</label>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-900/80 px-3 py-1 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
        </div>
      </div>

      {/* Evaluator Configuration */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 shadow-lg shadow-slate-950/40">
        <button
          onClick={() => setShowEvaluatorConfig((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-4"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-amber-300">Call Evaluators</span>
            {flaggedCalls.length > 0 && (
              <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-xs font-semibold text-rose-300">
                {flaggedCalls.length} flagged
              </span>
            )}
          </div>
          <span className="text-xs text-slate-400">{showEvaluatorConfig ? '▲ collapse' : '▼ configure'}</span>
        </button>

        {showEvaluatorConfig && (
          <div className="grid gap-4 border-t border-amber-500/20 px-5 py-4 sm:grid-cols-3">
            {/* High LLM Latency */}
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="eval-latency"
                checked={evaluators.highLatency.enabled}
                onChange={(e) => updateEvaluator('highLatency', { enabled: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 accent-amber-400"
              />
              <label htmlFor="eval-latency" className="flex-1 text-sm text-slate-300">
                <span className="block font-medium">High LLM Latency</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highLatency.threshold}
                    onChange={(e) => updateEvaluator('highLatency', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highLatency.enabled}
                    className="w-20 rounded border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-xs text-slate-100 disabled:opacity-40"
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
                className="mt-0.5 h-4 w-4 rounded border-slate-600 accent-amber-400"
              />
              <label htmlFor="eval-interruptions" className="flex-1 text-sm text-slate-300">
                <span className="block font-medium">High Interruptions</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highInterruptions.threshold}
                    onChange={(e) => updateEvaluator('highInterruptions', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highInterruptions.enabled}
                    className="w-16 rounded border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-xs text-slate-100 disabled:opacity-40"
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
                className="mt-0.5 h-4 w-4 rounded border-slate-600 accent-amber-400"
              />
              <label htmlFor="eval-failrate" className="flex-1 text-sm text-slate-300">
                <span className="block font-medium">Tool Failure Rate</span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-xs text-slate-500">flag if &gt;</span>
                  <input
                    type="number"
                    value={evaluators.highFailureRate.threshold}
                    onChange={(e) => updateEvaluator('highFailureRate', { threshold: Number(e.target.value) })}
                    disabled={!evaluators.highFailureRate.enabled}
                    className="w-16 rounded border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-xs text-slate-100 disabled:opacity-40"
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
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Total Calls</div>
          <div className="mt-2 text-3xl font-bold text-slate-100">{stats.totalCalls}</div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Avg Duration</div>
          <div className="mt-2 text-3xl font-bold text-slate-100">
            {formatDuration(stats.avgCallDuration * 1000)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Tool Calls</div>
          <div className="mt-2 text-3xl font-bold text-slate-100">{stats.totalToolCalls}</div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Failed Tools</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-rose-400">{stats.failedToolCalls}</span>
            {stats.totalToolCalls > 0 && (
              <span className="text-sm text-slate-500">
                ({((stats.failedToolCalls / stats.totalToolCalls) * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Avg LLM Latency</div>
          <div className="mt-2 text-3xl font-bold text-slate-100">
            {stats.avgLlmLatency > 0 ? formatDuration(stats.avgLlmLatency) : '—'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-slate-950/40">
          <div className="text-xs uppercase tracking-wide text-slate-400">Avg Interruptions</div>
          <div className="mt-2 text-3xl font-bold text-slate-100">
            {stats.avgInterruptions > 0 ? stats.avgInterruptions.toFixed(1) : '—'}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-slate-950/40">
        <div className="flex border-b border-slate-800">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-b-2 border-sky-500 text-sky-400'
                  : 'text-slate-400 hover:text-slate-300'
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
                <div className="py-8 text-center text-emerald-400">
                  No calls flagged by current evaluators
                </div>
              ) : (
                flaggedCalls.map(({ call, reasons }) => {
                  const toolCalls = call.metrics?.tool_calls || [];
                  const interruptions = getInterruptionCount(call);
                  return (
                    <div
                      key={call.id}
                      className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
                            <span>{new Date(call.createdAt).toLocaleString()}</span>
                            {call.customerPhone && (
                              <span className="font-mono text-slate-300">{call.customerPhone}</span>
                            )}
                            {call.intent && (
                              <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                                {call.intent}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {reasons.map((reason, i) => (
                              <span
                                key={i}
                                className="rounded-full bg-rose-500/15 px-2 py-1 text-xs text-rose-300"
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
                <div className="py-8 text-center text-slate-400">
                  No tool usage data available for this time range
                </div>
              ) : (
                Object.entries(stats.toolPerformance)
                  .sort(([, a], [, b]) => b.count - a.count)
                  .map(([toolName, tool]) => (
                    <div
                      key={toolName}
                      className="rounded-lg border border-slate-700 bg-slate-900/50 p-4"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h3 className="font-semibold text-slate-100">{toolName}</h3>
                          <div className="mt-2 flex flex-wrap gap-4 text-sm">
                            <div>
                              <span className="text-slate-400">Calls: </span>
                              <span className="font-medium text-slate-200">{tool.count}</span>
                            </div>
                            <div>
                              <span className="text-slate-400">Success Rate: </span>
                              <span className={`font-medium ${getSuccessColor(tool.successRate)}`}>
                                {(tool.successRate * 100).toFixed(1)}%
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400">Avg Latency: </span>
                              <span className="font-medium text-slate-200">
                                {formatDuration(tool.avgLatency)}
                              </span>
                            </div>
                          </div>
                        </div>
                        {tool.successRate < 0.9 && (
                          <span className="rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-400">
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
                <div className="py-8 text-center text-emerald-400">
                  No errors detected in this time range
                </div>
              ) : (
                stats.topErrors.map((error, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="font-mono text-sm text-rose-400">{error.type}</div>
                        <div className="mt-1 text-sm text-slate-300">{error.message}</div>
                      </div>
                      <span className="rounded-full bg-rose-500/20 px-3 py-1 text-sm font-semibold text-rose-300">
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
              {/* Summary Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
                  <div className="text-sm text-slate-400">Calls with Registration</div>
                  <div className="mt-1 text-2xl font-bold text-slate-100">
                    {stats.registrationMetrics.callsWithRegLookup}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.totalCalls > 0 ? ((stats.registrationMetrics.callsWithRegLookup / stats.totalCalls) * 100).toFixed(1) : '0.0'}% of total calls
                  </div>
                </div>

                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <div className="text-sm text-slate-400">First-Attempt Success</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-400">
                    {stats.registrationMetrics.firstAttemptSuccessRate.toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.registrationMetrics.callsWithRegLookup - stats.registrationMetrics.callsWithMultipleAttempts} successful on first try
                  </div>
                </div>

                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="text-sm text-slate-400">Retry Rate</div>
                  <div className="mt-1 text-2xl font-bold text-amber-400">
                    {stats.registrationMetrics.retryRate.toFixed(1)}%
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {stats.registrationMetrics.callsWithMultipleAttempts} calls needed multiple attempts
                  </div>
                </div>

                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
                  <div className="text-sm text-slate-400">3+ Attempts</div>
                  <div className="mt-1 text-2xl font-bold text-rose-400">
                    {stats.registrationMetrics.threeOrMoreAttemptsCount}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Calls requiring 3 or more tries
                  </div>
                </div>
              </div>

              {/* Common Issues Breakdown */}
              {stats.registrationMetrics.callsWithMultipleAttempts > 0 && (
                <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                  <h3 className="mb-4 text-lg font-semibold text-slate-100">Common Issues</h3>
                  <div className="space-y-3">
                    {/* Partial Capture Card */}
                    <div>
                      <button
                        onClick={() => setExpandedIssueType(expandedIssueType === 'partial' ? null : 'partial')}
                        className="w-full flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 transition-all hover:bg-amber-500/10 hover:border-amber-500/30 cursor-pointer"
                      >
                        <div className="flex-1 text-left">
                          <div className="font-medium text-amber-300">Partial Capture</div>
                          <div className="mt-1 text-sm text-slate-400">
                            Less than 5 characters captured on first attempt
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="text-2xl font-bold text-amber-400">
                              {stats.registrationMetrics.partialCaptureCount}
                            </div>
                            <div className="text-xs text-slate-500">
                              {stats.registrationMetrics.callsWithMultipleAttempts > 0 
                                ? ((stats.registrationMetrics.partialCaptureCount / stats.registrationMetrics.callsWithMultipleAttempts) * 100).toFixed(1) 
                                : '0.0'}%
                            </div>
                          </div>
                          <svg 
                            className={`w-5 h-5 text-amber-400 transition-transform ${expandedIssueType === 'partial' ? 'rotate-180' : ''}`} 
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
                              <div key={idx} className="rounded border border-amber-500/20 bg-slate-900/50 p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-300">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-400">
                                        {issue.call.customerPhone}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-amber-400">
                                      {issue.details}
                                    </div>
                                  </div>
                                  <a
                                    href={`/calls/${issue.call.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-3 rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/30"
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
                        className="w-full flex items-center justify-between rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 transition-all hover:bg-rose-500/10 hover:border-rose-500/30 cursor-pointer"
                      >
                        <div className="flex-1 text-left">
                          <div className="font-medium text-rose-300">"Not Finding" Errors</div>
                          <div className="mt-1 text-sm text-slate-400">
                            Registration not found in Garage Hive system
                          </div>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <div>
                            <div className="text-2xl font-bold text-rose-400">
                              {stats.registrationMetrics.notFoundCount}
                            </div>
                            <div className="text-xs text-slate-500">
                              {stats.registrationMetrics.callsWithMultipleAttempts > 0 
                                ? ((stats.registrationMetrics.notFoundCount / stats.registrationMetrics.callsWithMultipleAttempts) * 100).toFixed(1) 
                                : '0.0'}%
                            </div>
                          </div>
                          <svg 
                            className={`w-5 h-5 text-rose-400 transition-transform ${expandedIssueType === 'notFound' ? 'rotate-180' : ''}`} 
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
                              <div key={idx} className="rounded border border-rose-500/20 bg-slate-900/50 p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-300">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-400">
                                        {issue.call.customerPhone}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-rose-400">
                                      {issue.details}
                                    </div>
                                  </div>
                                  <a
                                    href={`/calls/${issue.call.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-3 rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30"
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
                          <div className="mt-1 text-sm text-slate-400">
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
                              <div key={idx} className="rounded border border-purple-500/20 bg-slate-900/50 p-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm text-slate-300">
                                      {new Date(issue.call.createdAt).toLocaleString()}
                                    </div>
                                    {issue.call.customerPhone && (
                                      <div className="mt-1 font-mono text-xs text-slate-400">
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
                <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-slate-100">Analysis Insights</h3>
                  <div className="space-y-2 text-sm text-slate-300">
                    {stats.registrationMetrics.retryRate > 50 && (
                      <div className="flex items-start gap-2">
                        <span className="text-amber-400">⚠️</span>
                        <span>
                          High retry rate ({stats.registrationMetrics.retryRate.toFixed(1)}%) indicates potential issues with registration capture. Common causes include background noise, unclear speech, or S/C confusion.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.firstAttemptSuccessRate > 70 && (
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-400">✓</span>
                        <span>
                          Strong first-attempt success rate ({stats.registrationMetrics.firstAttemptSuccessRate.toFixed(1)}%) shows effective initial capture in most cases.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.partialCaptureCount > stats.registrationMetrics.callsWithMultipleAttempts * 0.3 && (
                      <div className="flex items-start gap-2">
                        <span className="text-amber-400">💡</span>
                        <span>
                          Partial captures are a significant issue. Consider improving prompts to encourage customers to spell out complete registrations.
                        </span>
                      </div>
                    )}
                    {stats.registrationMetrics.notFoundCount > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-slate-400">ℹ️</span>
                        <span>
                          {stats.registrationMetrics.notFoundCount} registration(s) not found in system may indicate new customers or incorrect spelling.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {stats.registrationMetrics.callsWithRegLookup === 0 && (
                <div className="py-8 text-center text-slate-400">
                  No registration lookups in this time range
                </div>
              )}

              {/* Booking Abandonment Analysis */}
              {stats.bookingMetrics.bookingIntentCalls > 0 && (
                <>
                  <div className="mt-6 border-t border-slate-700 pt-6">
                    <h2 className="mb-4 text-xl font-bold text-slate-100">Booking Analysis</h2>
                  </div>

                  {/* Booking Summary Cards */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
                      <div className="text-sm text-slate-400">Booking Intent Calls</div>
                      <div className="mt-1 text-2xl font-bold text-slate-100">
                        {stats.bookingMetrics.bookingIntentCalls}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Customers wanted to book
                      </div>
                    </div>

                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                      <div className="text-sm text-slate-400">Completed Bookings</div>
                      <div className="mt-1 text-2xl font-bold text-emerald-400">
                        {stats.bookingMetrics.completedBookings}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Successfully created jobs
                      </div>
                    </div>

                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
                      <div className="text-sm text-slate-400">Abandoned Bookings</div>
                      <div className="mt-1 text-2xl font-bold text-rose-400">
                        {stats.bookingMetrics.abandonedBookings}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Intent but no booking created
                      </div>
                    </div>

                    <div className={`rounded-lg border p-4 ${
                      stats.bookingMetrics.conversionRate >= 70 
                        ? 'border-emerald-500/30 bg-emerald-500/5' 
                        : stats.bookingMetrics.conversionRate >= 50
                        ? 'border-amber-500/30 bg-amber-500/5'
                        : 'border-rose-500/30 bg-rose-500/5'
                    }`}>
                      <div className="text-sm text-slate-400">Conversion Rate</div>
                      <div className={`mt-1 text-2xl font-bold ${
                        stats.bookingMetrics.conversionRate >= 70 
                          ? 'text-emerald-400' 
                          : stats.bookingMetrics.conversionRate >= 50
                          ? 'text-amber-400'
                          : 'text-rose-400'
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
                    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                      <h3 className="mb-4 text-lg font-semibold text-slate-100">Abandonment Reasons</h3>
                      <div className="space-y-3">
                        {/* No Timeslots */}
                        <div>
                          <button
                            onClick={() => setExpandedAbandonmentReason(expandedAbandonmentReason === 'noTimeslots' ? null : 'noTimeslots')}
                            className="w-full flex items-center justify-between rounded-lg border border-orange-500/20 bg-orange-500/5 p-4 transition-all hover:bg-orange-500/10 hover:border-orange-500/30 cursor-pointer"
                          >
                            <div className="flex-1 text-left">
                              <div className="font-medium text-orange-300">No Available Timeslots</div>
                              <div className="mt-1 text-sm text-slate-400">
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
                                  <div key={idx} className="rounded border border-orange-500/20 bg-slate-900/50 p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-300">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-400">
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
                              <div className="mt-1 text-sm text-slate-400">
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
                                  <div key={idx} className="rounded border border-purple-500/20 bg-slate-900/50 p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-300">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-400">
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
                              <div className="mt-1 text-sm text-slate-400">
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
                                  <div key={idx} className="rounded border border-yellow-500/20 bg-slate-900/50 p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-300">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-400">
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
                              <div className="mt-1 text-sm text-slate-400">
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
                                  <div key={idx} className="rounded border border-blue-500/20 bg-slate-900/50 p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-300">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-400">
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
                              <div className="font-medium text-slate-300">Other Reasons</div>
                              <div className="mt-1 text-sm text-slate-400">
                                Customer changed mind or other factors
                              </div>
                            </div>
                            <div className="text-right flex items-center gap-3">
                              <div>
                                <div className="text-2xl font-bold text-slate-400">
                                  {stats.bookingMetrics.otherReasonsCount}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {stats.bookingMetrics.abandonedBookings > 0 
                                    ? ((stats.bookingMetrics.otherReasonsCount / stats.bookingMetrics.abandonedBookings) * 100).toFixed(1) 
                                    : '0.0'}%
                                </div>
                              </div>
                              <svg 
                                className={`w-5 h-5 text-slate-400 transition-transform ${expandedAbandonmentReason === 'other' ? 'rotate-180' : ''}`} 
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
                                  <div key={idx} className="rounded border border-slate-500/20 bg-slate-900/50 p-3">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="text-sm text-slate-300">
                                          {new Date(abandonment.call.createdAt).toLocaleString()}
                                        </div>
                                        {abandonment.call.customerPhone && (
                                          <div className="mt-1 font-mono text-xs text-slate-400">
                                            {abandonment.call.customerPhone}
                                          </div>
                                        )}
                                        <div className="mt-1 text-xs text-slate-400">
                                          {abandonment.details}
                                        </div>
                                      </div>
                                      <a
                                        href={`/calls/${abandonment.call.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-3 rounded bg-slate-500/20 px-2 py-1 text-xs text-slate-300 hover:bg-slate-500/30"
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
                  <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-6">
                    <h3 className="mb-3 text-lg font-semibold text-slate-100">Booking Insights</h3>
                    <div className="space-y-2 text-sm text-slate-300">
                      {stats.bookingMetrics.conversionRate < 50 && (
                        <div className="flex items-start gap-2">
                          <span className="text-rose-400">⚠️</span>
                          <span>
                            Low conversion rate ({stats.bookingMetrics.conversionRate.toFixed(1)}%) - Only {stats.bookingMetrics.completedBookings} of {stats.bookingMetrics.bookingIntentCalls} booking intents converted to actual bookings.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.conversionRate >= 70 && (
                        <div className="flex items-start gap-2">
                          <span className="text-emerald-400">✓</span>
                          <span>
                            Excellent conversion rate ({stats.bookingMetrics.conversionRate.toFixed(1)}%) - {stats.bookingMetrics.completedBookings} bookings from {stats.bookingMetrics.bookingIntentCalls} calls with booking intent.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.noTimeslotsCount > stats.bookingMetrics.abandonedBookings * 0.3 && (
                        <div className="flex items-start gap-2">
                          <span className="text-amber-400">💡</span>
                          <span>
                            Timeslot availability is a significant issue ({stats.bookingMetrics.noTimeslotsCount} calls). Consider expanding available appointment times or improving scheduling flexibility.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.costConcernCount > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-slate-400">ℹ️</span>
                          <span>
                            {stats.bookingMetrics.costConcernCount} customer(s) mentioned cost concerns. Review pricing communication strategy.
                          </span>
                        </div>
                      )}
                      {stats.bookingMetrics.noMatchingServiceCount > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-slate-400">ℹ️</span>
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
                        ? 'border-rose-500/30 bg-rose-500/5'
                        : 'border-slate-700 bg-slate-900/50'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="text-sm text-slate-400">
                          {new Date(call.createdAt).toLocaleString()}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-3 text-sm">
                          <div>
                            <span className="text-slate-400">Duration: </span>
                            <span className="text-slate-200">{formatDuration(call.duration * 1000)}</span>
                          </div>
                          {call.intent && (
                            <div>
                              <span className="text-slate-400">Intent: </span>
                              <span className="text-slate-200">{call.intent}</span>
                            </div>
                          )}
                          {(call.metrics?.avg_llm_latency_ms ?? 0) > 0 && (
                            <div>
                              <span className="text-slate-400">LLM Latency: </span>
                              <span className="text-slate-200">
                                {formatDuration(call.metrics!.avg_llm_latency_ms!)}
                              </span>
                            </div>
                          )}
                          {interruptions > 0 && (
                            <div>
                              <span className="text-slate-400">Interruptions: </span>
                              <span className="text-slate-200">{interruptions}</span>
                            </div>
                          )}
                          <div>
                            <span className="text-slate-400">Tools: </span>
                            <span className="text-slate-200">{toolCalls.length}</span>
                          </div>
                        </div>
                        {toolCalls.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {toolCalls.map((tc, idx) => (
                              <span
                                key={idx}
                                className={`rounded-full px-2 py-1 text-xs font-medium ${
                                  tc.success
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : 'bg-rose-500/10 text-rose-400'
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

'use client';

import { useEffect, useState } from 'react';
import { getGarageId } from '../../lib/auth';

interface ToolCall {
  tool_name: string;
  duration_ms: number;
  success: boolean;
  error_type?: string;
  error?: string;
  parameters?: any;
}

interface CallData {
  id: string;
  createdAt: string;
  duration: number;
  intent?: string;
  metrics?: {
    tool_calls?: ToolCall[];
    tool_call_count?: number;
    failed_tool_calls?: number;
    total_tool_latency_ms?: number;
    conversation_metrics?: any;
  };
}

interface AggregatedStats {
  totalCalls: number;
  avgCallDuration: number;
  totalToolCalls: number;
  failedToolCalls: number;
  toolPerformance: {
    [toolName: string]: {
      count: number;
      successRate: number;
      avgLatency: number;
      errors: { type: string; count: number; message: string }[];
    };
  };
  topErrors: { type: string; count: number; message: string }[];
}

export function ObservabilityDashboard() {
  const [timeRange, setTimeRange] = useState('24h');
  const [selectedGarage, setSelectedGarage] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<CallData[]>([]);
  const [stats, setStats] = useState<AggregatedStats>({
    totalCalls: 0,
    avgCallDuration: 0,
    totalToolCalls: 0,
    failedToolCalls: 0,
    toolPerformance: {},
    topErrors: [],
  });
  const [activeTab, setActiveTab] = useState<'tools' | 'errors' | 'calls'>('tools');

  useEffect(() => {
    fetchData();
  }, [timeRange, selectedGarage]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const garageId = getGarageId() || 'any';
      
      // Calculate date range
      const now = new Date();
      let startDate = new Date();
      if (timeRange === '24h') {
        startDate.setHours(now.getHours() - 24);
      } else if (timeRange === '7d') {
        startDate.setDate(now.getDate() - 7);
      } else if (timeRange === '30d') {
        startDate.setDate(now.getDate() - 30);
      }

      const response = await fetch(
        `/api/garages/${garageId}/calls?startDate=${startDate.toISOString()}&endDate=${now.toISOString()}`
      );
      
      if (!response.ok) throw new Error('Failed to fetch calls');
      
      const data = await response.json();
      const callsData = data.calls || [];
      
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

    callsData.forEach((call) => {
      totalCallDuration += call.duration || 0;
      const toolCalls = call.metrics?.tool_calls || [];
      
      toolCalls.forEach((tc) => {
        totalToolCalls++;
        if (!tc.success) failedToolCalls++;

        if (!toolPerformance[tc.tool_name]) {
          toolPerformance[tc.tool_name] = {
            count: 0,
            successRate: 0,
            avgLatency: 0,
            errors: [],
          };
        }

        const tool = toolPerformance[tc.tool_name];
        tool.count++;
        
        if (tc.success) {
          tool.successRate = ((tool.successRate * (tool.count - 1)) + 1) / tool.count;
        } else {
          tool.successRate = (tool.successRate * (tool.count - 1)) / tool.count;
          
          if (tc.error_type) {
            const errorKey = `${tc.tool_name}:${tc.error_type}`;
            const existing = errorMap.get(errorKey);
            if (existing) {
              existing.count++;
            } else {
              errorMap.set(errorKey, {
                count: 1,
                message: tc.error || tc.error_type,
              });
            }
          }
        }
        
        tool.avgLatency = ((tool.avgLatency * (tool.count - 1)) + tc.duration_ms) / tool.count;
      });
    });

    // Convert error map to sorted array
    const topErrors = Array.from(errorMap.entries())
      .map(([key, value]) => ({
        type: key,
        count: value.count,
        message: value.message,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    setStats({
      totalCalls: callsData.length,
      avgCallDuration: callsData.length > 0 ? totalCallDuration / callsData.length : 0,
      totalToolCalls,
      failedToolCalls,
      toolPerformance,
      topErrors,
    });
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-slate-400">Loading observability data...</div>
      </div>
    );
  }

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

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4">
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
      </div>

      {/* Tabs */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-slate-950/40">
        <div className="flex border-b border-slate-800">
          <button
            onClick={() => setActiveTab('tools')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'tools'
                ? 'border-b-2 border-sky-500 text-sky-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Tool Performance
          </button>
          <button
            onClick={() => setActiveTab('errors')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'errors'
                ? 'border-b-2 border-sky-500 text-sky-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Error Analysis
          </button>
          <button
            onClick={() => setActiveTab('calls')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'calls'
                ? 'border-b-2 border-sky-500 text-sky-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Recent Calls
          </button>
        </div>

        <div className="p-6">
          {/* Tool Performance Tab */}
          {activeTab === 'tools' && (
            <div className="space-y-4">
              {Object.keys(stats.toolPerformance).length === 0 ? (
                <div className="text-center text-slate-400 py-8">
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
                            ⚠️ Needs Attention
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
                <div className="text-center text-emerald-400 py-8">
                  ✓ No errors detected in this time range
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

          {/* Recent Calls Tab */}
          {activeTab === 'calls' && (
            <div className="space-y-3">
              {calls.slice(0, 20).map((call) => {
                const toolCalls = call.metrics?.tool_calls || [];
                const hasErrors = toolCalls.some(tc => !tc.success);
                
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
                                {!tc.success && ' ✗'}
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

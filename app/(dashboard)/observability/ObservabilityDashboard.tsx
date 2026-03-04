'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, TrendingDown, Clock, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';

interface ToolCall {
  tool: string;
  timestamp: number;
  duration_ms: number;
  success: boolean;
  parameters?: Record<string, any>;
  result?: any;
  error?: string;
  error_type?: string;
  retry_count?: number;
}

interface CallMetrics {
  id: string;
  garageId: string;
  garageName: string;
  roomName: string;
  durationSeconds: number;
  callType: string;
  confirmedBooking: boolean;
  createdAt: string;
  metrics: {
    tool_calls?: ToolCall[];
    tool_call_count?: number;
    failed_tool_calls?: number;
    total_tool_latency_ms?: number;
    llm_response_count?: number;
    avg_llm_latency_ms?: number;
    conversation_metrics?: {
      total_turns?: number;
      interruptions?: number;
      avg_turn_gap_seconds?: number;
    };
    vrn_attempts?: number;
    vrn_readback_rejections?: number;
  };
}

interface AggregatedStats {
  totalCalls: number;
  totalToolCalls: number;
  failedToolCalls: number;
  avgCallDuration: number;
  avgToolLatency: number;
  bookingSuccessRate: number;
  topErrors: Array<{ error: string; count: number; error_type?: string }>;
  toolPerformance: Array<{ tool: string; avgDuration: number; successRate: number; callCount: number }>;
}

export function ObservabilityDashboard() {
  const [calls, setCalls] = useState<CallMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState('24h');
  const [selectedGarage, setSelectedGarage] = useState<string>('all');
  const [garages, setGarages] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    fetchData();
    fetchGarages();
  }, [timeRange, selectedGarage]);

  const fetchGarages = async () => {
    try {
      const res = await fetch('/api/garages/assigned');
      const data = await res.json();
      setGarages(data.garages || []);
    } catch (error) {
      console.error('Failed to fetch garages:', error);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const now = new Date();
      let startDate = new Date();
      
      switch (timeRange) {
        case '24h':
          startDate.setHours(now.getHours() - 24);
          break;
        case '7d':
          startDate.setDate(now.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(now.getDate() - 30);
          break;
      }

      const params = new URLSearchParams({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        pageSize: '1000',
      });

      if (selectedGarage !== 'all') {
        params.append('garageIds', selectedGarage);
      } else {
        // Get all garages
        garages.forEach(g => params.append('garageIds', g.id));
      }

      const res = await fetch(`/api/garages/any/calls?${params.toString()}`);
      const data = await res.json();
      
      // Enrich with garage names
      const enrichedCalls = (data.calls || []).map((call: any) => ({
        ...call,
        garageName: garages.find(g => g.id === call.garageId)?.name || call.garageId,
      }));
      
      setCalls(enrichedCalls);
    } catch (error) {
      console.error('Failed to fetch observability data:', error);
    } finally {
      setLoading(false);
    }
  };

  const aggregateStats = (): AggregatedStats => {
    const totalCalls = calls.length;
    const confirmedBookings = calls.filter(c => c.confirmedBooking).length;
    
    let totalToolCalls = 0;
    let failedToolCalls = 0;
    let totalToolLatency = 0;
    let totalCallDuration = 0;
    const errorMap = new Map<string, { count: number; error_type?: string }>();
    const toolStats = new Map<string, { durations: number[]; successes: number; failures: number }>();

    calls.forEach(call => {
      totalCallDuration += call.durationSeconds;
      
      if (call.metrics?.tool_calls) {
        call.metrics.tool_calls.forEach(tc => {
          totalToolCalls++;
          totalToolLatency += tc.duration_ms || 0;
          
          if (!tc.success) {
            failedToolCalls++;
            if (tc.error) {
              const key = tc.error.substring(0, 100); // Truncate for grouping
              const existing = errorMap.get(key);
              errorMap.set(key, { 
                count: (existing?.count || 0) + 1,
                error_type: tc.error_type 
              });
            }
          }

          // Tool performance tracking
          const toolKey = tc.tool;
          if (!toolStats.has(toolKey)) {
            toolStats.set(toolKey, { durations: [], successes: 0, failures: 0 });
          }
          const stats = toolStats.get(toolKey)!;
          stats.durations.push(tc.duration_ms);
          if (tc.success) {
            stats.successes++;
          } else {
            stats.failures++;
          }
        });
      }
    });

    const topErrors = Array.from(errorMap.entries())
      .map(([error, { count, error_type }]) => ({ error, count, error_type }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const toolPerformance = Array.from(toolStats.entries())
      .map(([tool, stats]) => ({
        tool,
        avgDuration: stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length,
        successRate: (stats.successes / (stats.successes + stats.failures)) * 100,
        callCount: stats.successes + stats.failures,
      }))
      .sort((a, b) => b.callCount - a.callCount);

    return {
      totalCalls,
      totalToolCalls,
      failedToolCalls,
      avgCallDuration: totalCallDuration / totalCalls || 0,
      avgToolLatency: totalToolLatency / totalToolCalls || 0,
      bookingSuccessRate: (confirmedBookings / totalCalls) * 100 || 0,
      topErrors,
      toolPerformance,
    };
  };

  const stats = aggregateStats();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4">
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Time range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>

        <Select value={selectedGarage} onValueChange={setSelectedGarage}>
          <SelectTrigger className="w-[250px]">
            <SelectValue placeholder="Select garage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Garages</SelectItem>
            {garages.map(garage => (
              <SelectItem key={garage.id} value={garage.id}>
                {garage.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Calls</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCalls}</div>
            <p className="text-xs text-muted-foreground">
              {stats.bookingSuccessRate.toFixed(1)}% booking success rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tool Calls</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalToolCalls}</div>
            <p className="text-xs text-muted-foreground">
              Avg: {stats.avgToolLatency.toFixed(0)}ms latency
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed Tools</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.failedToolCalls}</div>
            <p className="text-xs text-muted-foreground">
              {((stats.failedToolCalls / stats.totalToolCalls) * 100 || 0).toFixed(1)}% failure rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Call Duration</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{Math.round(stats.avgCallDuration)}s</div>
            <p className="text-xs text-muted-foreground">
              {(stats.avgCallDuration / 60).toFixed(1)} minutes
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Analytics */}
      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tools">Tool Performance</TabsTrigger>
          <TabsTrigger value="errors">Error Analysis</TabsTrigger>
          <TabsTrigger value="calls">Recent Calls</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tool Performance Breakdown</CardTitle>
              <CardDescription>
                Average latency and success rate per tool
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {stats.toolPerformance.map((tool, idx) => (
                  <div key={idx} className="flex items-center justify-between border-b pb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{tool.tool}</span>
                        <Badge variant={tool.successRate >= 95 ? 'default' : 'destructive'}>
                          {tool.successRate.toFixed(1)}% success
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {tool.callCount} calls • {tool.avgDuration.toFixed(0)}ms avg
                      </p>
                    </div>
                    <div className="text-right">
                      {tool.successRate >= 95 ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <AlertCircle className="h-5 w-5 text-yellow-500" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Top Errors</CardTitle>
              <CardDescription>
                Most frequent errors across all calls
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {stats.topErrors.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No errors in this time period</p>
                ) : (
                  stats.topErrors.map((error, idx) => (
                    <div key={idx} className="border-b pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="destructive">{error.count}x</Badge>
                            {error.error_type && (
                              <Badge variant="outline">{error.error_type}</Badge>
                            )}
                          </div>
                          <p className="text-sm font-mono text-gray-700 dark:text-gray-300">
                            {error.error}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="calls" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Calls with Tool Data</CardTitle>
              <CardDescription>
                Last {calls.length} calls with observability metrics
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {calls.slice(0, 20).map((call) => (
                  <div key={call.id} className="border-b pb-3">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-medium text-sm">{call.garageName}</span>
                        <span className="text-xs text-muted-foreground ml-2">
                          {new Date(call.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <Badge variant={call.confirmedBooking ? 'default' : 'secondary'}>
                          {call.callType}
                        </Badge>
                        {call.confirmedBooking && (
                          <Badge variant="default" className="bg-green-500">
                            ✓ Booked
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Duration:</span>{' '}
                        <span className="font-medium">{call.durationSeconds}s</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Tool Calls:</span>{' '}
                        <span className="font-medium">{call.metrics?.tool_call_count || 0}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Failed:</span>{' '}
                        <span className={`font-medium ${(call.metrics?.failed_tool_calls || 0) > 0 ? 'text-red-600' : ''}`}>
                          {call.metrics?.failed_tool_calls || 0}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Latency:</span>{' '}
                        <span className="font-medium">{call.metrics?.total_tool_latency_ms?.toFixed(0) || 0}ms</span>
                      </div>
                    </div>
                    {call.metrics?.tool_calls && call.metrics.tool_calls.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {call.metrics.tool_calls.map((tc, idx) => (
                          <Badge 
                            key={idx} 
                            variant={tc.success ? 'outline' : 'destructive'}
                            className="text-xs"
                          >
                            {tc.tool} ({tc.duration_ms.toFixed(0)}ms)
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

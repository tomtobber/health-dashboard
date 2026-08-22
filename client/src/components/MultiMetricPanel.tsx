
function formatTimestampSafely(val?: string | null, fmt = 'PPP p'): string {
  if (!val) return '';
  try {
    const d = typeof val === 'string' ? parseISO(val) : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return format(d, fmt);
  } catch {
    return String(val);
  }
}
import React, { useEffect, useState, useMemo } from 'react';
import {
  DashboardPanelConfig,
  EnrichedMetricQueryResult,
  } from '../types';
import { api } from '../services/api';
import {
  ResponsiveContainer,
  LineChart,
  BarChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  } from 'recharts';
import { format, parseISO, subDays, subHours, subYears } from 'date-fns';
import { Settings, Trash2, AlertCircle, RefreshCw, TrendingUp } from 'lucide-react';

interface MultiMetricPanelProps {
  panel: DashboardPanelConfig;
  user: { id: string; email: string } | null;
  onEdit: () => void;
  onRemove: () => void;
  onOpenAuth?: () => void;
}

const SERIES_COLORS = [
  '#6366f1', // Indigo
  '#06b6d4', // Cyan
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#f43f5e', // Rose
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#14b8a6', // Teal
];

export const MultiMetricPanel: React.FC<MultiMetricPanelProps> = ({ panel, user, onEdit, onRemove, onOpenAuth }) => {
  const [data, setData] = useState<EnrichedMetricQueryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Compute absolute start/end from timeRange
  const { startTimeStr, endTimeStr, formattedRangeLabel } = useMemo(() => {
    const now = new Date();
    let start: Date;
    let end: Date = now;
    let label = '';

    if (panel.timeRange.type === 'relative') {
      switch (panel.timeRange.value) {
        case 'last_24h':
          start = subHours(now, 24);
          label = 'Last 24 Hours';
          break;
        case 'last_7d':
          start = subDays(now, 7);
          label = 'Last 7 Days';
          break;
        case 'last_30d':
          start = subDays(now, 30);
          label = 'Last 30 Days';
          break;
        case 'last_90d':
          start = subDays(now, 90);
          label = 'Last 90 Days';
          break;
        case 'last_1y':
          start = subYears(now, 1);
          label = 'Last 1 Year';
          break;
      }
    } else {
      start = parseISO(panel.timeRange.startTime);
      end = parseISO(panel.timeRange.endTime);
      label = `${format(start, 'MMM d, yyyy')} - ${format(end, 'MMM d, yyyy')}`;
    }

    return {
      startTimeStr: start.toISOString(),
      endTimeStr: end.toISOString(),
      formattedRangeLabel: label,
    };
  }, [panel.timeRange]);

  const fetchData = async () => {
    if (!user) {
      setData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const results = await api.queryBatchEnrichedMetrics({
        metric_types: panel.metricTypes,
        start_time: startTimeStr,
        end_time: endTimeStr,
        aggregation: panel.aggregation,
      });
      setData(results);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load panel metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [user?.id, panel.metricTypes, startTimeStr, endTimeStr, panel.aggregation]);

  // Separate metrics by valueType
  const numericMetrics = useMemo(() => data.filter((d) => d.valueType === 'numeric' || d.valueType === 'duration'), [data]);
  const booleanMetrics = useMemo(() => data.filter((d) => d.valueType === 'boolean'), [data]);
  const categoryMetrics = useMemo(() => data.filter((d) => d.valueType === 'category'), [data]);

  // Merge timelines into unified array of time buckets for Recharts
  const chartData = useMemo(() => {
    const timeMap = new Map<string, { time: string; timestamp: number; [key: string]: any }>();

    for (const metric of numericMetrics) {
      for (const entry of metric.entries) {
        const timeKey = entry.startTime;
        const ts = new Date(timeKey).getTime();
        if (!timeMap.has(timeKey)) {
          timeMap.set(timeKey, {
            time: timeKey,
            timestamp: ts,
          });
        }
        const point = timeMap.get(timeKey)!;
        point[metric.metricType] = entry.valueNumeric;
      }
    }

    const sorted = Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    return sorted;
  }, [numericMetrics]);

  // Collect discrete events for boolean / category overlays
  const discreteEvents = useMemo(() => {
    const events: Array<{ time: string; timestamp: number; metricType: string; displayName: string; label: string; color: string; valueType: string }> = [];

    let colorIdx = numericMetrics.length;
    for (const metric of booleanMetrics) {
      const color = SERIES_COLORS[colorIdx % SERIES_COLORS.length];
      colorIdx++;
      for (const entry of metric.entries) {
        if (entry.valueNumeric === 1) {
          events.push({
            time: entry.startTime,
            timestamp: new Date(entry.startTime).getTime(),
            metricType: metric.metricType,
            displayName: metric.displayName,
            label: 'Completed / Active',
            color,
            valueType: 'boolean',
          });
        }
      }
    }

    for (const metric of categoryMetrics) {
      const color = SERIES_COLORS[colorIdx % SERIES_COLORS.length];
      colorIdx++;
      for (const entry of metric.entries) {
        if (entry.valueText) {
          events.push({
            time: entry.startTime,
            timestamp: new Date(entry.startTime).getTime(),
            metricType: metric.metricType,
            displayName: metric.displayName,
            label: entry.valueText,
            color,
            valueType: 'category',
          });
        }
      }
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }, [booleanMetrics, categoryMetrics, numericMetrics.length]);

  return (
    <div className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', height: '460px', position: 'relative' }}>
      {/* Panel Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {data.map((m, idx) => (
            <span
              key={m.metricType}
              className="badge"
              style={{
                background: `${SERIES_COLORS[idx % SERIES_COLORS.length]}22`,
                borderColor: `${SERIES_COLORS[idx % SERIES_COLORS.length]}66`,
                color: SERIES_COLORS[idx % SERIES_COLORS.length],
                borderWidth: '1px',
                borderStyle: 'solid',
              }}
            >
              {m.displayName} {m.unit ? `(${m.unit})` : ''}
              {m.isArchived && ' [Archived]'}
            </span>
          ))}
          {data.length === 0 && !loading && (
            <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>No metrics selected</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '0.25rem' }}>
            {formattedRangeLabel} ({panel.aggregation})
          </span>
          <button className="btn btn-secondary btn-icon" onClick={fetchData} title="Refresh panel data">
            <RefreshCw size={14} className={loading ? 'spin-anim' : ''} />
          </button>
          <button className="btn btn-secondary btn-icon" onClick={onEdit} title="Configure panel metrics and time range">
            <Settings size={14} />
          </button>
          <button className="btn btn-danger btn-icon" onClick={onRemove} title="Remove panel">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div style={{ flex: 1, width: '100%', position: 'relative' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15, 23, 42, 0.6)', zIndex: 10, borderRadius: '12px' }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <RefreshCw size={16} className="spin-anim" /> Loading time series...
            </span>
          </div>
        )}

        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
            <AlertCircle size={28} />
            <span style={{ fontSize: '0.875rem' }}>{error}</span>
            <button className="btn btn-secondary" onClick={fetchData} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>
              Retry
            </button>
          </div>
        )}

        {!user && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: '0.75rem' }}>
            <TrendingUp size={32} strokeWidth={1.5} color="var(--accent-primary)" />
            <span style={{ fontSize: '0.875rem' }}>Sign in to view real-time data & custom metrics</span>
            {onOpenAuth && (
              <button className="btn btn-primary" style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }} onClick={onOpenAuth}>
                Sign In / Demo
              </button>
            )}
          </div>
        )}

        {user && !loading && !error && chartData.length === 0 && discreteEvents.length === 0 && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: '0.5rem' }}>
            <TrendingUp size={32} strokeWidth={1.5} />
            <span style={{ fontSize: '0.875rem' }}>No data points recorded for this time window.</span>
          </div>
        )}

        {!error && (chartData.length > 0 || discreteEvents.length > 0) && (
          <ResponsiveContainer width="100%" height="100%">
            {panel.chartType === 'bar' ? (
              <BarChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="time"
                  tickFormatter={(t) => {
                    try {
                      return format(parseISO(t), 'MMM d');
                    } catch {
                      return t;
                    }
                  }}
                  stroke="#64748b"
                  fontSize={11}
                />
                {numericMetrics.map((m, idx) => (
                  <YAxis
                    key={m.metricType}
                    yAxisId={m.metricType}
                    orientation={idx % 2 === 0 ? 'left' : 'right'}
                    stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    fontSize={11}
                    tickFormatter={(v) => `${v} ${m.unit || ''}`}
                  />
                ))}
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="custom-recharts-tooltip">
                          <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                            {formatTimestampSafely(label)}
                          </p>
                          {payload.map((entry: any, i: number) => (
                            <p key={i} style={{ fontSize: '0.8125rem', color: entry.color, fontWeight: 600 }}>
                              {entry.name}: {entry.value}
                            </p>
                          ))}
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                {numericMetrics.map((m, idx) => (
                  <Bar
                    key={m.metricType}
                    yAxisId={m.metricType}
                    dataKey={m.metricType}
                    name={m.displayName}
                    fill={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            ) : (
              <LineChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="time"
                  tickFormatter={(t) => {
                    try {
                      return format(parseISO(t), 'MMM d');
                    } catch {
                      return t;
                    }
                  }}
                  stroke="#64748b"
                  fontSize={11}
                />
                {numericMetrics.map((m, idx) => (
                  <YAxis
                    key={m.metricType}
                    yAxisId={m.metricType}
                    orientation={idx % 2 === 0 ? 'left' : 'right'}
                    stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    fontSize={11}
                    tickFormatter={(v) => `${v} ${m.unit || ''}`}
                  />
                ))}
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="custom-recharts-tooltip">
                          <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>
                            {formatTimestampSafely(label)}
                          </p>
                          {payload.map((entry: any, i: number) => (
                            <p key={i} style={{ fontSize: '0.8125rem', color: entry.color, fontWeight: 600 }}>
                              {entry.name}: {entry.value}
                            </p>
                          ))}
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                {numericMetrics.map((m, idx) => (
                  <Line
                    key={m.metricType}
                    yAxisId={m.metricType}
                    type="monotone"
                    dataKey={m.metricType}
                    name={m.displayName}
                    stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    strokeWidth={2.5}
                    dot={{ r: 2 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* Discrete Annotation Track (Boolean & Category Event Markers) */}
      {discreteEvents.length > 0 && (
        <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '0.5rem', overflowX: 'auto' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Events:</span>
          {discreteEvents.slice(-10).map((ev, i) => (
            <span
              key={i}
              className="badge"
              style={{
                background: `${ev.color}18`,
                borderColor: `${ev.color}55`,
                color: ev.color,
                borderWidth: '1px',
                borderStyle: 'solid',
                whiteSpace: 'nowrap',
              }}
              title={`${ev.displayName} at ${format(parseISO(ev.time), 'PPP p')}`}
            >
              {ev.displayName}: <strong>{ev.label}</strong> ({format(parseISO(ev.time), 'MMM d, p')})
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

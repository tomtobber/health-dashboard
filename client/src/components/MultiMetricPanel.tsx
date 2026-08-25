import { buildChartTimelineData } from '../utils/timeScale';

export function formatDurationValue(value: number, unit: string | null): string {
  if (unit === 'minutes') {
    const h = Math.floor(value / 60);
    const m = Math.round(value % 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  return unit ? `${value} ${unit}` : `${value}`;
}


function formatTimestampSafely(val?: string | number | Date | null, fmt = 'PPP p'): string {
  if (val === undefined || val === null || val === '') return '';
  try {
    const d = typeof val === 'number' ? new Date(val) : (typeof val === 'string' ? parseISO(val) : val);
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
  onSeedDemo?: () => void;
  onOpenLog?: () => void;
  onOpenBaseline?: (metricType: string, displayName?: string) => void;
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

export const MultiMetricPanel: React.FC<MultiMetricPanelProps> = ({ panel, user, onEdit, onRemove, onOpenAuth, onSeedDemo, onOpenLog, onOpenBaseline }) => {
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
  const safeData = useMemo(() => Array.isArray(data) ? data : [], [data]);
  const metricMap = useMemo(() => {
    const map = new Map<string, EnrichedMetricQueryResult>();
    for (const m of safeData) {
      if (m && m.metricType) {
        map.set(m.metricType, m);
      }
    }
    return map;
  }, [safeData]);
  const numericMetrics = useMemo(() => safeData.filter((d) => d && (d.valueType === 'numeric' || d.valueType === 'duration')), [safeData]);
  const booleanMetrics = useMemo(() => safeData.filter((d) => d && d.valueType === 'boolean'), [safeData]);
  const categoryMetrics = useMemo(() => safeData.filter((d) => d && d.valueType === 'category'), [safeData]);

  const chartData = useMemo(() => {
    const isDaily = panel.aggregation === 'daily_avg' || panel.aggregation === 'weekly_avg' || (panel.timeRange.type === 'relative' && panel.timeRange.value !== 'last_24h');
    return buildChartTimelineData(numericMetrics, isDaily);
  }, [numericMetrics, panel.aggregation, panel.timeRange]);

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
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span>
                {m.displayName} {m.unit ? `(${m.unit})` : ''}
                {m.isArchived && ' [Archived]'}
              </span>
              {onOpenBaseline && (m.valueType === 'numeric' || m.valueType === 'duration') && (
                <button
                  type="button"
                  onClick={() => onOpenBaseline(m.metricType, m.displayName)}
                  title="View Historical Baseline"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'currentColor',
                    cursor: 'pointer',
                    fontSize: '0.6875rem',
                    textDecoration: 'underline',
                    padding: '0 2px',
                    opacity: 0.85,
                  }}
                >
                  Baseline
                </button>
              )}
            </span>
          ))}
          {data.length === 0 && !loading && (
            <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>No metrics selected</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '0.25rem' }}>
            {formattedRangeLabel}
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
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: '0.75rem' }}>
            <TrendingUp size={32} strokeWidth={1.5} color="var(--text-muted)" />
            <span style={{ fontSize: '0.875rem' }}>No data points recorded for this time window.</span>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              {onSeedDemo && (
                <button className="btn btn-primary" style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }} onClick={onSeedDemo}>
                  ✨ Load 14-Day Sample Data
                </button>
              )}
              {onOpenLog && (
                <button className="btn btn-secondary" style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }} onClick={onOpenLog}>
                  + Log Entry
                </button>
              )}
            </div>
          </div>
        )}

        {!error && (chartData.length > 0 || discreteEvents.length > 0) && (
          <ResponsiveContainer width="100%" height="100%">
            {panel.chartType === 'bar' ? (
              <BarChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(ts) => {
                    try {
                      const d = new Date(Number(ts));
                      if (isNaN(d.getTime())) return '';
                      return format(d, panel.timeRange.type === 'relative' && panel.timeRange.value === 'last_24h' ? 'p' : 'MMM d');
                    } catch {
                      return '';
                    }
                  }}
                  stroke="#64748b"
                  fontSize={11}
                />
                {numericMetrics.map((m, idx) => (
                  <YAxis
                    key={m.metricType}
                    yAxisId={m.metricType}
                    domain={[0, 'auto']}
                    orientation={idx % 2 === 0 ? 'left' : 'right'}
                    stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    fontSize={11}
                    tickFormatter={(v) => formatDurationValue(v, m.unit)}
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
                          {payload.map((entry: any, i: number) => {
                            const metric = metricMap.get(entry.dataKey);
                            const formattedVal = typeof entry.value === 'number'
                              ? formatDurationValue(entry.value, metric?.unit || null)
                              : `${entry.value}`;
                            return (
                              <p key={i} style={{ fontSize: '0.8125rem', color: entry.color, fontWeight: 600 }}>
                                {entry.name}: {formattedVal}
                              </p>
                            );
                          })}
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
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(ts) => {
                    try {
                      const d = new Date(Number(ts));
                      if (isNaN(d.getTime())) return '';
                      return format(d, panel.timeRange.type === 'relative' && panel.timeRange.value === 'last_24h' ? 'p' : 'MMM d');
                    } catch {
                      return '';
                    }
                  }}
                  stroke="#64748b"
                  fontSize={11}
                />
                {numericMetrics.map((m, idx) => (
                  <YAxis
                    key={m.metricType}
                    yAxisId={m.metricType}
                    domain={['auto', 'auto']}
                    orientation={idx % 2 === 0 ? 'left' : 'right'}
                    stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                    fontSize={11}
                    tickFormatter={(v) => formatDurationValue(v, m.unit)}
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
                          {payload.map((entry: any, i: number) => {
                            const metric = metricMap.get(entry.dataKey);
                            const formattedVal = typeof entry.value === 'number'
                              ? formatDurationValue(entry.value, metric?.unit || null)
                              : `${entry.value}`;
                            return (
                              <p key={i} style={{ fontSize: '0.8125rem', color: entry.color, fontWeight: 600 }}>
                                {entry.name}: {formattedVal}
                              </p>
                            );
                          })}
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

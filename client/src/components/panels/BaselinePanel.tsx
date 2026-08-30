import React, { useEffect, useState, useCallback } from 'react';
import { BaselinePanelConfig, BaselineResult, BaselineHistoryItem } from '../../types';
import { api } from '../../services/api';
import { ALL_CANONICAL_METRICS } from '../PanelConfigModal';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { Settings, Trash2, RefreshCw, Activity, AlertCircle, Info } from 'lucide-react';

interface BaselinePanelProps {
  panel: BaselinePanelConfig;
  user: { id: string; email: string } | null;
  onEdit: () => void;
  onRemove: () => void;
  onOpenAuth?: () => void;
}

export const BaselinePanel: React.FC<BaselinePanelProps> = ({
  panel,
  user,
  onEdit,
  onRemove,
  onOpenAuth,
}) => {
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);
  const [history, setHistory] = useState<BaselineHistoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fetchPanelData = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [baselineSettled, historySettled] = await Promise.allSettled([
      api.getBaseline(panel.metricType),
      api.getBaselineHistory(panel.metricType),
    ]);

    if (baselineSettled.status === 'fulfilled') {
      setBaseline(baselineSettled.value);
    } else {
      const err = baselineSettled.reason;
      setError(err instanceof Error ? err.message : 'Failed to calculate live baseline');
    }

    if (historySettled.status === 'fulfilled') {
      setHistory(historySettled.value.history || []);
    }

    setLoading(false);
  }, [panel.metricType, user]);

  useEffect(() => {
    fetchPanelData();
  }, [fetchPanelData]);

  const handleRefreshHistory = async () => {
    setRefreshing(true);
    setToastMessage(null);

    try {
      let hasMore = true;
      let totalSnapshotsAdded = 0;
            let iterations = 0;
      const MAX_ITERATIONS = 20;

      while (hasMore && iterations < MAX_ITERATIONS) {
        const summary = await api.refreshBaselineHistory(panel.metricType);
        totalSnapshotsAdded += summary.snapshotsAdded;
                hasMore = summary.hasMore;
        iterations++;
      }

      // Determine result message per exact spec
      if (hasMore) {
        setToastMessage('Refreshed part of your history. Run again to continue.');
      } else if (totalSnapshotsAdded > 0) {
        setToastMessage(`Added ${totalSnapshotsAdded} new snapshot(s).`);
      } else {
        setToastMessage('Already up to date.');
      }

      // Re-fetch baseline history to update history strip
      const res = await api.getBaselineHistory(panel.metricType);
      setHistory(res.history || []);

      setTimeout(() => {
        setToastMessage(null);
      }, 5000);
    } catch (err: unknown) {
      setToastMessage(err instanceof Error ? err.message : 'Failed to refresh baseline history');
      setTimeout(() => {
        setToastMessage(null);
      }, 5000);
    } finally {
      setRefreshing(false);
    }
  };

  const canonical = ALL_CANONICAL_METRICS.find((m) => m.metricType === panel.metricType);
  const displayName = (baseline && baseline.displayName) || (canonical && canonical.displayName) || panel.metricType;
  const unit = (baseline && 'unit' in baseline && baseline.unit) || (canonical && canonical.unit) || '';

  // Format history data for recharts
  const chartData = history.map((item) => {
    let dateLabel = item.computedAt;
    try {
      dateLabel = format(parseISO(item.computedAt), 'MMM yyyy');
    } catch {
      // Fallback
    }

    return {
      dateLabel,
      computedAt: item.computedAt,
      mean: item.mean,
      stddev: item.stddev,
      sampleSize: item.sampleSize,
      min: item.min,
      max: item.max,
    };
  });

  return (
    <div className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '380px' }}>
      {/* 1. Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={18} color="var(--accent-primary)" />
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            {displayName}
          </h3>
          <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)', fontWeight: 500 }}>
            Personal Baseline
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <button className="btn btn-secondary btn-icon" onClick={onEdit} title="Configure panel">
            <Settings size={14} />
          </button>
          <button className="btn btn-secondary btn-icon" onClick={onRemove} title="Remove panel">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {!user ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem' }}>Log in to view personal baseline statistics and history.</p>
          <button className="btn btn-primary" onClick={onOpenAuth}>Log In</button>
        </div>
      ) : loading ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', color: 'var(--text-muted)' }}>
          <RefreshCw size={24} className="spin-anim" />
          <span style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>Loading baseline analytics...</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', flex: 1 }}>
          {error && (
            <div style={{ padding: '0.75rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem' }}>
              {error}
            </div>
          )}

          {/* Toast / Result Message */}
          {toastMessage && (
            <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Info size={15} color="var(--accent-primary)" />
              <span>{toastMessage}</span>
            </div>
          )}

          {/* 2. Current Baseline Section */}
          <div>
            {baseline && !baseline.ok ? (
              <div style={{ padding: '0.875rem 1rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <AlertCircle size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <p style={{ margin: 0, color: '#f59e0b', fontSize: '0.8125rem', lineHeight: 1.5 }}>
                    Insufficient data to calculate a baseline for {baseline.displayName}. Found {baseline.sampleSize} entries in the last {baseline.windowDays} days (minimum required: {baseline.minRequired}).
                  </p>
                </div>
              </div>
            ) : baseline && baseline.ok ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ padding: '0.875rem 1rem', background: 'var(--bg-card-header)', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                    {baseline.mean} ± {baseline.stddev} {baseline.unit || ''}, based on your last {baseline.windowDays} days (n={baseline.sampleSize})
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                    Observed range: {baseline.min} – {baseline.max} {baseline.unit || ''}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                  <div style={{ padding: '0.5rem', background: 'var(--bg-card-header)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Mean</div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.mean}</div>
                  </div>
                  <div style={{ padding: '0.5rem', background: 'var(--bg-card-header)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Std Dev (±)</div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.stddev}</div>
                  </div>
                  <div style={{ padding: '0.5rem', background: 'var(--bg-card-header)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Min</div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.min}</div>
                  </div>
                  <div style={{ padding: '0.5rem', background: 'var(--bg-card-header)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Max</div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.max}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* 3. History Strip Section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Baseline History
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {history.length > 0 ? `${history.length} monthly snapshot(s)` : ''}
              </span>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: '1.5rem 1rem', background: 'rgba(255,255,255,0.02)', border: '1px dashed var(--border-color)', borderRadius: '8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                No baseline history yet for {displayName}. Refresh to generate it.
              </div>
            ) : (
              <div style={{ width: '100%', height: '160px', background: 'rgba(0,0,0,0.1)', borderRadius: '8px', padding: '0.5rem' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 15, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="dateLabel"
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      tickLine={{ stroke: 'var(--border-color)' }}
                    />
                    <YAxis
                      domain={['dataMin - 1', 'dataMax + 1']}
                      tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                      tickLine={{ stroke: 'var(--border-color)' }}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const pt = payload[0].payload;
                          return (
                            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.75rem' }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
                                {pt.dateLabel}
                              </div>
                              <div style={{ color: 'var(--accent-primary)' }}>
                                Baseline Mean: {pt.mean} {unit}
                              </div>
                              <div style={{ color: 'var(--text-secondary)' }}>
                                Std Dev: ±{pt.stddev}
                              </div>
                              <div style={{ color: 'var(--text-muted)' }}>
                                Sample Size: n={pt.sampleSize}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="mean"
                      stroke="var(--accent-primary)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: 'var(--accent-primary)' }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* 4. Refresh Button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRefreshHistory}
              disabled={refreshing}
              style={{ fontSize: '0.8125rem' }}
            >
              <RefreshCw size={13} className={refreshing ? 'spin-anim' : ''} />
              <span>{refreshing ? 'Refreshing...' : 'Refresh Baseline History'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

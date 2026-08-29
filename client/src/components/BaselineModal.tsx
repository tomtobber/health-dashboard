import React, { useState, useEffect, useCallback } from 'react';
import { BaselineResult, TrendResult } from '../types';
import { api } from '../services/api';
import { X, Activity, Settings2, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface BaselineModalProps {
  metricType: string;
  metricDisplayName?: string;
  onClose: () => void;
}

export const BaselineModal: React.FC<BaselineModalProps> = ({
  metricType,
  metricDisplayName,
  onClose,
}) => {
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [windowInput, setWindowInput] = useState<number>(90);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  const fetchAnalyticsData = useCallback(async (overrideDays?: number) => {
    setIsLoading(true);
    setBaselineError(null);
    setTrendError(null);

    const [baselineSettled, trendSettled, configSettled] = await Promise.allSettled([
      api.getBaseline(metricType, overrideDays),
      api.getTrend(metricType, overrideDays),
      api.getBaselineConfig(metricType),
    ]);

    if (baselineSettled.status === 'fulfilled') {
      setBaseline(baselineSettled.value);
    } else {
      setBaselineError(baselineSettled.reason instanceof Error ? baselineSettled.reason.message : 'Failed to calculate personal baseline');
    }

    if (trendSettled.status === 'fulfilled') {
      setTrend(trendSettled.value);
    } else {
      setTrendError(trendSettled.reason instanceof Error ? trendSettled.reason.message : 'Failed to calculate directional trend');
    }

    if (configSettled.status === 'fulfilled' && !overrideDays) {
      setWindowInput(configSettled.value.configured ? configSettled.value.windowDays : configSettled.value.default);
    }

    setIsLoading(false);
  }, [metricType]);

  useEffect(() => {
    fetchAnalyticsData();
  }, [fetchAnalyticsData]);

  const handleSaveWindow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (windowInput < 7 || windowInput > 3650) {
      setBaselineError('Window days must be between 7 and 3650');
      return;
    }

    setIsSaving(true);
    setBaselineError(null);
    setTrendError(null);
    setSaveSuccess(false);

    try {
      await api.setBaselineConfig(metricType, windowInput);
      setSaveSuccess(true);
      await fetchAnalyticsData(windowInput);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      setBaselineError(err instanceof Error ? err.message : 'Failed to save baseline window configuration');
    } finally {
      setIsSaving(false);
    }
  };

  const displayName =
    (baseline && baseline.displayName) ||
    (trend && trend.displayName) ||
    metricDisplayName ||
    metricType;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={20} color="var(--accent-primary)" />
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Personal Baseline: {displayName}
            </h2>
          </div>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {baselineError && (
          <div style={{ padding: '0.75rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {baselineError}
          </div>
        )}

        {trendError && (
          <div style={{ padding: '0.75rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {trendError}
          </div>
        )}

        {saveSuccess && (
          <div style={{ padding: '0.75rem', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', color: '#10b981', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            Baseline window configuration saved successfully.
          </div>
        )}

        {isLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            <RefreshCw size={24} className="spin" />
            <span>Calculating analytics...</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '1.5rem' }}>
            {/* Baseline Section */}
            <div>
              {baseline && !baseline.ok ? (
                <div style={{ padding: '1rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px' }}>
                  <p style={{ margin: 0, color: '#f59e0b', fontSize: '0.875rem', lineHeight: 1.5 }}>
                    Insufficient data to calculate a baseline for {baseline.displayName}. Found {baseline.sampleSize} entries in the last {baseline.windowDays} days (minimum required: {baseline.minRequired}).
                  </p>
                </div>
              ) : baseline && baseline.ok ? (
                <div>
                  <div style={{ padding: '1.125rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '10px', marginBottom: '0.75rem' }}>
                    <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                      Your baseline for {baseline.displayName}: {baseline.mean} ± {baseline.stddev} {baseline.unit || ''}, based on your last {baseline.windowDays} days (n={baseline.sampleSize}).
                    </p>
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      Observed range in this window: {baseline.min} – {baseline.max} {baseline.unit || ''}
                    </p>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
                    <div style={{ padding: '0.75rem', background: 'var(--bg-card-header)', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Mean</div>
                      <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.mean}</div>
                    </div>
                    <div style={{ padding: '0.75rem', background: 'var(--bg-card-header)', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Std Dev (±)</div>
                      <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.stddev}</div>
                    </div>
                    <div style={{ padding: '0.75rem', background: 'var(--bg-card-header)', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Min</div>
                      <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.min}</div>
                    </div>
                    <div style={{ padding: '0.75rem', background: 'var(--bg-card-header)', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Max</div>
                      <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{baseline.max}</div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Directional Trend Section */}
            <div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                Directional Trend
              </div>
              {trend && !trend.ok ? (
                <div style={{ padding: '0.875rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px' }}>
                  <p style={{ margin: 0, color: '#f59e0b', fontSize: '0.8125rem', lineHeight: 1.5 }}>
                    Insufficient data to determine a trend for {trend.displayName}. Found {trend.sampleSize} days with data in the last {trend.windowDays} days (minimum required: {trend.minRequired}).
                  </p>
                </div>
              ) : trend && trend.ok ? (
                <div style={{ padding: '0.875rem 1rem', background: 'var(--bg-card-header)', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  {trend.direction === 'increasing' && <TrendingUp size={20} color="#10b981" />}
                  {trend.direction === 'decreasing' && <TrendingDown size={20} color="#6366f1" />}
                  {trend.direction === 'no_clear_trend' && <Minus size={20} color="var(--text-secondary)" />}
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {trend.direction === 'increasing' && `Trend: Increasing (+${trend.slopePerDay} ${trend.unit || ''}/day over last ${trend.windowDays} days, n=${trend.sampleSize} days)`}
                      {trend.direction === 'decreasing' && `Trend: Decreasing (${trend.slopePerDay} ${trend.unit || ''}/day over last ${trend.windowDays} days, n=${trend.sampleSize} days)`}
                      {trend.direction === 'no_clear_trend' && `Trend: No clear trend over last ${trend.windowDays} days (n=${trend.sampleSize} days)`}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.75rem' }}>
            <Settings2 size={16} color="var(--text-secondary)" />
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Historical Window Configuration
            </h3>
          </div>

          <form onSubmit={handleSaveWindow} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                Historical Window (Days)
              </label>
              <input
                type="number"
                className="input-field"
                min={7}
                max={3650}
                value={windowInput}
                onChange={(e) => setWindowInput(Number(e.target.value))}
                required
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.25rem' }}>
                Calculated over your trailing history up to right now. Governs both Personal Baseline and Directional Trend.
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Close
              </button>
              <button type="submit" className="btn btn-primary" disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Window'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

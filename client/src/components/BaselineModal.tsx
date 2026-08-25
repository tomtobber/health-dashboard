import React, { useState, useEffect, useCallback } from 'react';
import { BaselineResult } from '../types';
import { api } from '../services/api';
import { X, Activity, Settings2, RefreshCw } from 'lucide-react';

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
  const [windowInput, setWindowInput] = useState<number>(90);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  const fetchBaselineData = useCallback(async (overrideDays?: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const [baselineRes, configRes] = await Promise.all([
        api.getBaseline(metricType, overrideDays),
        api.getBaselineConfig(metricType),
      ]);
      setBaseline(baselineRes);
      if (!overrideDays) {
        setWindowInput(configRes.configured ? configRes.windowDays : configRes.default);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to calculate personal baseline');
    } finally {
      setIsLoading(false);
    }
  }, [metricType]);

  useEffect(() => {
    fetchBaselineData();
  }, [fetchBaselineData]);

  const handleSaveWindow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (windowInput < 7 || windowInput > 3650) {
      setError('Window days must be between 7 and 3650');
      return;
    }

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      await api.setBaselineConfig(metricType, windowInput);
      setSaveSuccess(true);
      await fetchBaselineData(windowInput);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save baseline window configuration');
    } finally {
      setIsSaving(false);
    }
  };

  const displayName =
    (baseline && (baseline.ok ? baseline.displayName : baseline.displayName)) ||
    metricDisplayName ||
    metricType;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '580px' }}>
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

        {error && (
          <div style={{ padding: '0.75rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {error}
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
            <span>Calculating baseline...</span>
          </div>
        ) : baseline && !baseline.ok ? (
          <div style={{ padding: '1rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', marginBottom: '1.25rem' }}>
            <p style={{ margin: 0, color: '#f59e0b', fontSize: '0.875rem', lineHeight: 1.5 }}>
              Insufficient data to calculate a baseline for {baseline.displayName}. Found {baseline.sampleSize} entries in the last {windowInput} days (minimum required: {baseline.minRequired}).
            </p>
          </div>
        ) : baseline && baseline.ok ? (
          <div style={{ marginBottom: '1.5rem' }}>
            <div style={{ padding: '1.125rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '10px', marginBottom: '1rem' }}>
              <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                Your baseline for {baseline.displayName}: {baseline.mean} ± {baseline.stddev} {baseline.unit || ''}, based on your last {baseline.windowDays} days (n={baseline.sampleSize}).
              </p>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                Observed range in this window: {baseline.min} – {baseline.max} {baseline.unit || ''}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
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
                Calculated over your trailing history up to right now.
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

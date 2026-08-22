import React, { useState } from 'react';
import { DashboardPanelConfig, MetricDefinition, TimeRange } from '../types';
import { X, Check } from 'lucide-react';

interface PanelConfigModalProps {
  panel: DashboardPanelConfig | null;
  definitions: MetricDefinition[];
  onSave: (config: DashboardPanelConfig) => void;
  onClose: () => void;
}

const CANONICAL_OPTIONS = [
  { metricType: 'heart-rate', displayName: 'Heart Rate', unit: 'bpm', type: 'numeric' },
  { metricType: 'steps', displayName: 'Steps', unit: 'count', type: 'numeric' },
  { metricType: 'sleep', displayName: 'Sleep Duration', unit: 'minutes', type: 'duration' },
  { metricType: 'daily-resting-heart-rate', displayName: 'Resting Heart Rate', unit: 'bpm', type: 'numeric' },
  { metricType: 'daily-heart-rate-variability', displayName: 'HRV (RMSSD)', unit: 'ms', type: 'numeric' },
  { metricType: 'active-zone-minutes', displayName: 'Active Zone Minutes', unit: 'minutes', type: 'duration' },
  { metricType: 'run-vo2-max', displayName: 'VO2 Max', unit: 'ml/kg/min', type: 'numeric' },
  { metricType: 'daily-oxygen-saturation', displayName: 'SpO2 Oxygen Saturation', unit: '%', type: 'numeric' },
  { metricType: 'weight', displayName: 'Weight', unit: 'kg', type: 'numeric' },
  { metricType: 'hydration-log', displayName: 'Hydration Log', unit: 'ml', type: 'numeric' },
];

export const PanelConfigModal: React.FC<PanelConfigModalProps> = ({
  panel,
  definitions,
  onSave,
  onClose,
}) => {
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(panel ? panel.metricTypes : ['heart-rate']);
  const [rangeType, setRangeType] = useState<'relative' | 'absolute'>(panel ? panel.timeRange.type : 'relative');
  const [relativeValue, setRelativeValue] = useState<'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_1y'>(
    panel && panel.timeRange.type === 'relative' ? panel.timeRange.value : 'last_7d'
  );
  const [startTime, setStartTime] = useState<string>(
    panel && panel.timeRange.type === 'absolute' ? panel.timeRange.startTime.slice(0, 10) : ''
  );
  const [endTime, setEndTime] = useState<string>(
    panel && panel.timeRange.type === 'absolute' ? panel.timeRange.endTime.slice(0, 10) : ''
  );
  const [aggregation, setAggregation] = useState<'raw' | '1m_avg' | '5m_avg' | 'daily_avg'>(
    panel ? panel.aggregation : 'daily_avg'
  );
  const [chartType, setChartType] = useState<'line' | 'bar'>(panel?.chartType || 'line');

  const toggleMetric = (key: string) => {
    if (selectedMetrics.includes(key)) {
      if (selectedMetrics.length > 1) {
        setSelectedMetrics(selectedMetrics.filter((m) => m !== key));
      }
    } else {
      setSelectedMetrics([...selectedMetrics, key]);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedMetrics.length === 0) return;

    let timeRange: TimeRange;
    if (rangeType === 'relative') {
      timeRange = { type: 'relative', value: relativeValue };
    } else {
      timeRange = {
        type: 'absolute',
        startTime: startTime ? new Date(startTime).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString(),
        endTime: endTime ? new Date(endTime + 'T23:59:59.999Z').toISOString() : new Date().toISOString(),
      };
    }

    onSave({
      id: panel ? panel.id : `panel-${Date.now()}`,
      metricTypes: selectedMetrics,
      timeRange,
      aggregation,
      chartType,
    });
  };

  // Combine custom metric definitions with canonical list
  const allMetricOptions = [
    ...definitions.map((d) => ({
      metricType: d.metricType,
      displayName: d.displayName,
      unit: d.unit,
      type: d.valueType,
      isCustom: true,
      isArchived: d.archivedAt !== null,
    })),
    ...CANONICAL_OPTIONS.filter((c) => !definitions.some((d) => d.metricType === c.metricType)),
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '580px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2>{panel ? 'Configure Panel' : 'Add Multi-Metric Panel'}</h2>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Multi-Metric Selection */}
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
              Select Metrics to Overlay (Pick 1 or more):
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', maxHeight: '160px', overflowY: 'auto', padding: '0.5rem', background: 'rgba(15,23,42,0.6)', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
              {allMetricOptions.map((opt) => {
                const isSelected = selectedMetrics.includes(opt.metricType);
                return (
                  <button
                    key={opt.metricType}
                    type="button"
                    onClick={() => toggleMetric(opt.metricType)}
                    className={`btn ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                  >
                    {isSelected && <Check size={12} />}
                    {opt.displayName} {opt.unit ? `(${opt.unit})` : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time Range Selector */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Time Range Mode
              </label>
              <select
                className="input-field"
                value={rangeType}
                onChange={(e) => setRangeType(e.target.value as 'relative' | 'absolute')}
              >
                <option value="relative">Relative (Up to Now)</option>
                <option value="absolute">Absolute (Fixed Date Range)</option>
              </select>
            </div>

            {rangeType === 'relative' ? (
              <div>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                  Relative Window
                </label>
                <select
                  className="input-field"
                  value={relativeValue}
                  onChange={(e) => setRelativeValue(e.target.value as any)}
                >
                  <option value="last_24h">Last 24 Hours</option>
                  <option value="last_7d">Last 7 Days</option>
                  <option value="last_30d">Last 30 Days</option>
                  <option value="last_90d">Last 90 Days</option>
                  <option value="last_1y">Last 1 Year</option>
                </select>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div>
                  <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                    Start Date
                  </label>
                  <input
                    type="date"
                    className="input-field"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                    End Date
                  </label>
                  <input
                    type="date"
                    className="input-field"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Aggregation & Chart Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Resolution / Aggregation
              </label>
              <select
                className="input-field"
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value as any)}
              >
                <option value="daily_avg">Daily Average</option>
                <option value="5m_avg">5-Minute Average</option>
                <option value="1m_avg">1-Minute Average</option>
                <option value="raw">Raw Resolution</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Chart Style
              </label>
              <select
                className="input-field"
                value={chartType}
                onChange={(e) => setChartType(e.target.value as 'line' | 'bar')}
              >
                <option value="line">Multi-Series Line</option>
                <option value="bar">Bar Chart</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Apply to Dashboard
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

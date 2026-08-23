import React, { useState, useMemo } from 'react';
import { DashboardPanelConfig, MetricDefinition, TimeRange } from '../types';
import { X, Check, Search } from 'lucide-react';

interface PanelConfigModalProps {
  panel: DashboardPanelConfig | null;
  definitions: MetricDefinition[];
  onSave: (config: DashboardPanelConfig) => void;
  onClose: () => void;
}

export interface MetricCatalogItem {
  metricType: string;
  displayName: string;
  unit: string | null;
  type: 'numeric' | 'duration' | 'boolean' | 'category';
  category: 'Cardio' | 'Activity' | 'Sleep & Recovery' | 'Vitals & Body' | 'Nutrition' | 'Custom';
  isCustom?: boolean;
}

export const ALL_CANONICAL_METRICS: MetricCatalogItem[] = [
  // Cardio
  { metricType: 'heart-rate', displayName: 'Heart Rate', unit: 'bpm', type: 'numeric', category: 'Cardio' },
  { metricType: 'daily-resting-heart-rate', displayName: 'Resting Heart Rate', unit: 'bpm', type: 'numeric', category: 'Cardio' },
  { metricType: 'daily-heart-rate-variability', displayName: 'HRV (RMSSD)', unit: 'ms', type: 'numeric', category: 'Cardio' },
  { metricType: 'heart-rate-variability', displayName: 'HRV Intraday', unit: 'ms', type: 'numeric', category: 'Cardio' },
  { metricType: 'daily-heart-rate-zones', displayName: 'Daily HR Zones', unit: 'minutes', type: 'numeric', category: 'Cardio' },
  { metricType: 'time-in-heart-rate-zone', displayName: 'Time in HR Zone', unit: 'minutes', type: 'numeric', category: 'Cardio' },

  // Activity
  { metricType: 'steps', displayName: 'Steps', unit: 'count', type: 'numeric', category: 'Activity' },
  { metricType: 'distance', displayName: 'Distance', unit: 'meters', type: 'numeric', category: 'Activity' },
  { metricType: 'active-zone-minutes', displayName: 'Active Zone Minutes', unit: 'minutes', type: 'duration', category: 'Activity' },
  { metricType: 'exercise', displayName: 'Exercise Sessions', unit: 'minutes', type: 'duration', category: 'Activity' },
  { metricType: 'run-vo2-max', displayName: 'VO2 Max', unit: 'mL/kg/min', type: 'numeric', category: 'Activity' },
  { metricType: 'activity-level', displayName: 'Activity Level', unit: null, type: 'category', category: 'Activity' },
  { metricType: 'sedentary-period', displayName: 'Sedentary Period', unit: 'minutes', type: 'duration', category: 'Activity' },
  { metricType: 'altitude', displayName: 'Altitude', unit: 'meters', type: 'numeric', category: 'Activity' },

  // Sleep & Recovery
  { metricType: 'sleep', displayName: 'Sleep Duration', unit: 'minutes', type: 'duration', category: 'Sleep & Recovery' },
  { metricType: 'daily-oxygen-saturation', displayName: 'SpO2 Oxygen Saturation', unit: '%', type: 'numeric', category: 'Sleep & Recovery' },
  { metricType: 'daily-respiratory-rate', displayName: 'Respiratory Rate', unit: 'breaths/min', type: 'numeric', category: 'Sleep & Recovery' },
  { metricType: 'respiratory-rate-sleep-summary', displayName: 'Sleep Respiratory Summary', unit: 'breaths/min', type: 'numeric', category: 'Sleep & Recovery' },
  { metricType: 'daily-sleep-temperature-derivations', displayName: 'Sleep Skin Temperature', unit: '°C', type: 'numeric', category: 'Sleep & Recovery' },

  // Vitals & Body
  { metricType: 'weight', displayName: 'Weight', unit: 'kg', type: 'numeric', category: 'Vitals & Body' },
  { metricType: 'body-fat', displayName: 'Body Fat %', unit: '%', type: 'numeric', category: 'Vitals & Body' },
  { metricType: 'height', displayName: 'Height', unit: 'cm', type: 'numeric', category: 'Vitals & Body' },
  { metricType: 'blood-glucose', displayName: 'Blood Glucose', unit: 'mg/dL', type: 'numeric', category: 'Vitals & Body' },
  { metricType: 'blood-pressure', displayName: 'Blood Pressure', unit: 'mmHg', type: 'numeric', category: 'Vitals & Body' },

  // Nutrition & Hydration
  { metricType: 'hydration-log', displayName: 'Hydration', unit: 'ml', type: 'numeric', category: 'Nutrition' },
  { metricType: 'nutrition-log', displayName: 'Nutrition', unit: 'kcal', type: 'numeric', category: 'Nutrition' },
  { metricType: 'total-calories', displayName: 'Total Calories', unit: 'kcal', type: 'numeric', category: 'Nutrition' },
];

export const PanelConfigModal: React.FC<PanelConfigModalProps> = ({
  panel,
  definitions,
  onSave,
  onClose,
}) => {
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(panel ? panel.metricTypes : ['heart-rate']);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
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

  // Combine custom metric definitions with full canonical list
  const fullCatalog = useMemo<MetricCatalogItem[]>(() => {
    const customItems: MetricCatalogItem[] = (Array.isArray(definitions) ? definitions : []).map((d) => ({
      metricType: d.metricType,
      displayName: d.displayName,
      unit: d.unit || null,
      type: d.valueType,
      category: 'Custom',
      isCustom: true,
    }));

    const canonicalFiltered = ALL_CANONICAL_METRICS.filter(
      (c) => !customItems.some((d) => d.metricType === c.metricType)
    );

    return [...customItems, ...canonicalFiltered];
  }, [definitions]);

  const categories = ['All', 'Cardio', 'Activity', 'Sleep & Recovery', 'Vitals & Body', 'Nutrition', 'Custom'];

  const filteredCatalog = useMemo(() => {
    return fullCatalog.filter((item) => {
      const matchesCategory = activeCategory === 'All' || item.category === activeCategory;
      const matchesSearch =
        searchQuery === '' ||
        item.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.metricType.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [fullCatalog, activeCategory, searchQuery]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2>{panel ? 'Configure Multi-Metric Panel' : 'Add Multi-Metric Panel'}</h2>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Multi-Metric Selection Catalog */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Select Metrics ({selectedMetrics.length} selected):
              </label>
              <div style={{ position: 'relative', width: '180px' }}>
                <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="Search metrics..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input-field"
                  style={{ paddingLeft: '26px', fontSize: '0.75rem', paddingBlock: '0.25rem' }}
                />
              </div>
            </div>

            {/* Category tabs */}
            <div style={{ display: 'flex', gap: '0.25rem', overflowX: 'auto', paddingBottom: '0.375rem', marginBottom: '0.5rem' }}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(cat)}
                  style={{
                    fontSize: '0.6875rem',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: activeCategory === cat ? 'var(--accent-primary)' : 'var(--border-subtle)',
                    background: activeCategory === cat ? 'rgba(59,130,246,0.15)' : 'transparent',
                    color: activeCategory === cat ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Metric pill list */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', maxHeight: '180px', overflowY: 'auto', padding: '0.5rem', background: 'rgba(15,23,42,0.6)', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
              {filteredCatalog.map((opt) => {
                const isSelected = selectedMetrics.includes(opt.metricType);
                return (
                  <button
                    key={opt.metricType}
                    type="button"
                    onClick={() => toggleMetric(opt.metricType)}
                    className={`btn ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    {isSelected && <Check size={12} />}
                    <span>{opt.displayName}</span>
                    {opt.unit && <span style={{ opacity: 0.6, fontSize: '0.6875rem' }}>({opt.unit})</span>}
                    {opt.isCustom && <span style={{ fontSize: '0.625rem', background: 'rgba(168,85,247,0.2)', color: '#c084fc', padding: '1px 4px', borderRadius: '4px' }}>Custom</span>}
                  </button>
                );
              })}
              {filteredCatalog.length === 0 && (
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '0.5rem' }}>No metrics match your search.</span>
              )}
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
                <option value="relative">Relative Window</option>
                <option value="absolute">Custom Date Range</option>
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

          {/* Resolution & Chart Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Resolution / Downsampling
              </label>
              <select
                className="input-field"
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value as any)}
              >
                <option value="daily_avg">Daily Resolution (Recommended)</option>
                <option value="5m_avg">5-Minute Intervals</option>
                <option value="1m_avg">1-Minute Intervals</option>
                <option value="raw">Raw / Exact Timestamps</option>
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
                <option value="line">Multi-Series Line (with Multi-Y-Axes)</option>
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

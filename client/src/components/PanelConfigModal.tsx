import React, { useState, useMemo } from 'react';
import { DashboardPanelConfig, MetricDefinition, TimeRange } from '../types';
import { X, Check, Search, BarChart3, Activity } from 'lucide-react';

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
  const initialPanelType = panel && 'panelType' in panel && panel.panelType === 'baseline' ? 'baseline' : 'chart';
  const [panelType, setPanelType] = useState<'chart' | 'baseline'>(initialPanelType);

  const initialChartMetrics = panel && (!('panelType' in panel) || panel.panelType === 'chart') ? panel.metricTypes : ['heart-rate'];
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(initialChartMetrics);

  const initialBaselineMetric = panel && 'panelType' in panel && panel.panelType === 'baseline' ? panel.metricType : 'heart-rate';
  const [selectedBaselineMetric, setSelectedBaselineMetric] = useState<string>(initialBaselineMetric);

  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const chartPanel = panel && (!('panelType' in panel) || panel.panelType === 'chart') ? panel : null;
  const [rangeType, setRangeType] = useState<'relative' | 'absolute'>(chartPanel ? chartPanel.timeRange.type : 'relative');
  const [relativeValue, setRelativeValue] = useState<'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_1y'>(
    chartPanel && chartPanel.timeRange.type === 'relative' ? chartPanel.timeRange.value : 'last_7d'
  );
  const [startTime, setStartTime] = useState<string>(
    chartPanel && chartPanel.timeRange.type === 'absolute' ? chartPanel.timeRange.startTime.slice(0, 10) : ''
  );
  const [endTime, setEndTime] = useState<string>(
    chartPanel && chartPanel.timeRange.type === 'absolute' ? chartPanel.timeRange.endTime.slice(0, 10) : ''
  );
  const [aggregation, setAggregation] = useState<'raw' | '1m_avg' | '5m_avg' | 'daily_avg' | 'weekly_avg'>(
    chartPanel ? chartPanel.aggregation : 'weekly_avg'
  );
  const [chartType, setChartType] = useState<'line' | 'bar'>(chartPanel?.chartType || 'line');

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

    if (panelType === 'baseline') {
      if (!selectedBaselineMetric) return;
      onSave({
        id: panel ? panel.id : `panel-${Date.now()}`,
        panelType: 'baseline',
        metricType: selectedBaselineMetric,
      });
      return;
    }

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
      panelType: 'chart',
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
      // For baseline panels, filter strictly to numeric and duration metrics
      if (panelType === 'baseline' && item.type !== 'numeric' && item.type !== 'duration') {
        return false;
      }

      const matchesCategory = activeCategory === 'All' || item.category === activeCategory;
      const matchesSearch =
        searchQuery === '' ||
        item.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.metricType.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [fullCatalog, activeCategory, searchQuery, panelType]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2>{panel ? 'Configure Panel' : 'Add Dashboard Panel'}</h2>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Panel Type Selector */}
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
              Panel Type:
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn"
                onClick={() => setPanelType('chart')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  border: '1px solid',
                  borderColor: panelType === 'chart' ? 'var(--accent-primary)' : 'var(--border-color)',
                  background: panelType === 'chart' ? 'rgba(99,102,241,0.15)' : 'var(--bg-card-header)',
                  color: panelType === 'chart' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  fontWeight: panelType === 'chart' ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                <BarChart3 size={18} />
                <span>Chart</span>
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => setPanelType('baseline')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  border: '1px solid',
                  borderColor: panelType === 'baseline' ? 'var(--accent-primary)' : 'var(--border-color)',
                  background: panelType === 'baseline' ? 'rgba(99,102,241,0.15)' : 'var(--bg-card-header)',
                  color: panelType === 'baseline' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  fontWeight: panelType === 'baseline' ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                <Activity size={18} />
                <span>Personal Baseline</span>
              </button>
            </div>
          </div>

          {/* Metric Selection Catalog */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {panelType === 'baseline'
                  ? 'Select Metric (numeric & duration only):'
                  : `Select Metrics (${selectedMetrics.length} selected):`}
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
                    padding: '3px 8px',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: activeCategory === cat ? 'var(--accent-primary)' : 'transparent',
                    background: activeCategory === cat ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
                    color: activeCategory === cat ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Catalog Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: '0.375rem',
                maxHeight: '180px',
                overflowY: 'auto',
                padding: '0.5rem',
                background: 'rgba(0,0,0,0.15)',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
              }}
            >
              {filteredCatalog.map((item) => {
                const isSelected = panelType === 'baseline'
                  ? selectedBaselineMetric === item.metricType
                  : selectedMetrics.includes(item.metricType);

                return (
                  <div
                    key={item.metricType}
                    onClick={() => {
                      if (panelType === 'baseline') {
                        setSelectedBaselineMetric(item.metricType);
                      } else {
                        toggleMetric(item.metricType);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor: isSelected ? 'var(--accent-primary)' : 'transparent',
                      background: isSelected ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.02)',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '4px' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                        {item.displayName}
                      </div>
                      <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>
                        {item.unit || item.type}
                      </div>
                    </div>
                    {isSelected && <Check size={14} color="var(--accent-primary)" style={{ flexShrink: 0 }} />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Chart-Specific Options */}
          {panelType === 'chart' && (
            <>
              {/* Aggregation & Chart Type */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                    Aggregation:
                  </label>
                  <select
                    className="input-field"
                    value={aggregation}
                    onChange={(e) => setAggregation(e.target.value as any)}
                  >
                    <option value="raw">Raw (No Aggregation)</option>
                    <option value="1m_avg">1-Minute Average</option>
                    <option value="5m_avg">5-Minute Average</option>
                    <option value="daily_avg">Daily Average</option>
                    <option value="weekly_avg">Weekly Average</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                    Chart Type:
                  </label>
                  <select
                    className="input-field"
                    value={chartType}
                    onChange={(e) => setChartType(e.target.value as 'line' | 'bar')}
                  >
                    <option value="line">Line Chart</option>
                    <option value="bar">Bar Chart</option>
                  </select>
                </div>
              </div>

              {/* Time Range Options */}
              <div>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                  Time Range:
                </label>
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="rangeType"
                      checked={rangeType === 'relative'}
                      onChange={() => setRangeType('relative')}
                    />
                    Relative Window
                  </label>
                  <label style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="rangeType"
                      checked={rangeType === 'absolute'}
                      onChange={() => setRangeType('absolute')}
                    />
                    Custom Date Range
                  </label>
                </div>

                {rangeType === 'relative' ? (
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
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div>
                      <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Start Date:</span>
                      <input
                        type="date"
                        className="input-field"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>End Date:</span>
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
            </>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={panelType === 'baseline' ? !selectedBaselineMetric : selectedMetrics.length === 0}
            >
              {panel ? 'Save Changes' : 'Add Panel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

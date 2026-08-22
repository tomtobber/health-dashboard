import React, { useState } from 'react';
import { MetricValueType } from '../types';
import { api } from '../services/api';
import { X } from 'lucide-react';

interface MetricDefinitionModalProps {
  onSuccess: () => void;
  onClose: () => void;
}

export const MetricDefinitionModal: React.FC<MetricDefinitionModalProps> = ({
  onSuccess,
  onClose,
}) => {
  const [metricType, setMetricType] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [valueType, setValueType] = useState<MetricValueType>('numeric');
  const [unit, setUnit] = useState('');
  const [categoriesInput, setCategoriesInput] = useState('Mild, Moderate, Severe');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const categoryValues =
        valueType === 'category'
          ? categoriesInput.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;

      await api.createMetricDefinition({
        metric_type: metricType.trim(),
        display_name: displayName.trim(),
        value_type: valueType,
        unit: valueType === 'numeric' || valueType === 'duration' ? unit.trim() : null,
        category_values: categoryValues,
      });

      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create metric definition');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2>Define Custom Metric</h2>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {error && (
          <div style={{ padding: '0.625rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Metric Key (strict kebab-case, e.g. alcohol-units, meditation-minutes)
            </label>
            <input
              type="text"
              className="input-field"
              placeholder="e.g. coffee-cups"
              value={metricType}
              onChange={(e) => setMetricType(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Display Name
            </label>
            <input
              type="text"
              className="input-field"
              placeholder="e.g. Coffee Cups"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Value Type
            </label>
            <select
              className="input-field"
              value={valueType}
              onChange={(e) => setValueType(e.target.value as MetricValueType)}
            >
              <option value="numeric">Numeric (Integer / Decimal)</option>
              <option value="duration">Duration (Time in seconds/minutes)</option>
              <option value="boolean">Boolean (Yes/No Status Event)</option>
              <option value="category">Category (Discrete Named Labels)</option>
            </select>
          </div>

          {(valueType === 'numeric' || valueType === 'duration') && (
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Unit (e.g. ml, cups, mg, seconds)
              </label>
              <input
                type="text"
                className="input-field"
                placeholder={valueType === 'duration' ? 'seconds' : 'units'}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                required={valueType === 'numeric'}
              />
            </div>
          )}

          {valueType === 'category' && (
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Category Values (comma-separated)
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g. None, Mild, Moderate, Severe"
                value={categoriesInput}
                onChange={(e) => setCategoriesInput(e.target.value)}
                required
              />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Metric'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { MetricDefinition } from '../types';
import { api } from '../services/api';
import { X } from 'lucide-react';

interface ManualEntryModalProps {
  definitions: MetricDefinition[];
  onSuccess: () => void;
  onClose: () => void;
}

export const ManualEntryModal: React.FC<ManualEntryModalProps> = ({
  definitions,
  onSuccess,
  onClose,
}) => {
  const activeDefs = (Array.isArray(definitions) ? definitions : []).filter((d) => d && d.archivedAt === null);

  const [selectedMetricType, setSelectedMetricType] = useState<string>(
    activeDefs[0] ? activeDefs[0].metricType : ''
  );
  const [startTime, setStartTime] = useState<string>(new Date().toISOString().slice(0, 16));
  const [valueNumeric, setValueNumeric] = useState<string>('');
  const [valueText, setValueText] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDef = definitions.find((d) => d.metricType === selectedMetricType);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMetricType || !selectedDef) return;

    setIsSubmitting(true);
    setError(null);

    try {
      let numericVal: number | undefined;
      let textVal: string | undefined;

      if (selectedDef.valueType === 'numeric' || selectedDef.valueType === 'duration') {
        numericVal = parseFloat(valueNumeric);
        if (isNaN(numericVal)) throw new Error('Please enter a valid number');
      } else if (selectedDef.valueType === 'boolean') {
        numericVal = valueNumeric === 'true' || valueNumeric === '1' ? 1 : 0;
      } else if (selectedDef.valueType === 'category') {
        textVal = valueText;
        if (!textVal) throw new Error('Please select a category value');
      }

      await api.logManualEntry({
        metric_type: selectedMetricType,
        start_time: new Date(startTime).toISOString(),
        value_numeric: numericVal,
        value_text: textVal,
      });

      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to log manual entry');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2>Log Manual Entry</h2>
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
              Custom Metric
            </label>
            <select
              className="input-field"
              value={selectedMetricType}
              onChange={(e) => {
                setSelectedMetricType(e.target.value);
                setValueNumeric('');
                setValueText('');
              }}
            >
              {activeDefs.map((d) => (
                <option key={d.id} value={d.metricType}>
                  {d.displayName} ({d.valueType}{d.unit ? `, ${d.unit}` : ''})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Date & Time
            </label>
            <input
              type="datetime-local"
              className="input-field"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
            />
          </div>

          {selectedDef && (selectedDef.valueType === 'numeric' || selectedDef.valueType === 'duration') && (
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Value ({selectedDef.unit || 'units'})
              </label>
              <input
                type="number"
                step="any"
                className="input-field"
                placeholder={`Enter value in ${selectedDef.unit || 'units'}`}
                value={valueNumeric}
                onChange={(e) => setValueNumeric(e.target.value)}
                required
              />
            </div>
          )}

          {selectedDef && selectedDef.valueType === 'boolean' && (
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Status / Event
              </label>
              <select
                className="input-field"
                value={valueNumeric}
                onChange={(e) => setValueNumeric(e.target.value)}
                required
              >
                <option value="">Select status...</option>
                <option value="1">Completed / True / Yes</option>
                <option value="0">Not Completed / False / No</option>
              </select>
            </div>
          )}

          {selectedDef && selectedDef.valueType === 'category' && (
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
                Category Value
              </label>
              <select
                className="input-field"
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                required
              >
                <option value="">Select label...</option>
                {(selectedDef.categoryValues || []).map((val) => (
                  <option key={val} value={val}>
                    {val}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Logging...' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

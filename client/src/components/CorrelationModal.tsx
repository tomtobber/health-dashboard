import React, { useState, useEffect, useCallback } from 'react';
import { CorrelationResult, MetricDefinition } from '../types';
import { api } from '../services/api';
import {
  X,
  ScatterChart as ScatterChartIcon,
  RefreshCw,
  AlertCircle,
  HelpCircle,
  TrendingUp,
  TrendingDown,
  Minus,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface CorrelationModalProps {
  initialMetricTypeA?: string;
  initialMetricTypeB?: string;
  onClose: () => void;
}

export const CorrelationModal: React.FC<CorrelationModalProps> = ({
  initialMetricTypeA,
  initialMetricTypeB,
  onClose,
}) => {
  const [metricDefinitions, setMetricDefinitions] = useState<MetricDefinition[]>([]);
  const [metricTypeA, setMetricTypeA] = useState<string>(initialMetricTypeA || '');
  const [metricTypeB, setMetricTypeB] = useState<string>(initialMetricTypeB || '');
  const [windowDays, setWindowDays] = useState<number>(90);
  const [correlation, setCorrelation] = useState<CorrelationResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load available metric definitions to populate dropdowns
  useEffect(() => {
    let mounted = true;
    api.listMetricDefinitions(true).then((defs) => {
      if (mounted) {
        // Filter to numeric and duration metrics only
        const validDefs = defs.filter(
          (d) => d.valueType === 'numeric' || d.valueType === 'duration'
        );
        setMetricDefinitions(validDefs);

        if (!initialMetricTypeA && validDefs.length > 0) {
          setMetricTypeA(validDefs[0].metricType);
        }
        if (!initialMetricTypeB && validDefs.length > 1) {
          setMetricTypeB(validDefs[1].metricType);
        }
      }
    }).catch((err) => {
      console.error('Failed to load metric definitions for correlation:', err);
    });

    return () => {
      mounted = false;
    };
  }, [initialMetricTypeA, initialMetricTypeB]);

  const fetchCorrelation = useCallback(async () => {
    if (!metricTypeA || !metricTypeB || metricTypeA === metricTypeB) {
      setCorrelation(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await api.getCorrelation(metricTypeA, metricTypeB, windowDays);
      setCorrelation(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to compute correlation');
      setCorrelation(null);
    } finally {
      setIsLoading(false);
    }
  }, [metricTypeA, metricTypeB, windowDays]);

  useEffect(() => {
    if (metricTypeA && metricTypeB && metricTypeA !== metricTypeB) {
      fetchCorrelation();
    }
  }, [fetchCorrelation, metricTypeA, metricTypeB]);

  const getMetricDisplayName = (type: string) => {
    const found = metricDefinitions.find((m) => m.metricType === type);
    return found ? found.displayName : type;
  };

  const displayNameA = correlation?.ok
    ? correlation.displayNameA
    : getMetricDisplayName(metricTypeA);
  const displayNameB = correlation?.ok
    ? correlation.displayNameB
    : getMetricDisplayName(metricTypeB);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl max-w-2xl w-full p-6 text-slate-100 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-5">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <ScatterChartIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                {metricTypeA && metricTypeB && metricTypeA !== metricTypeB
                  ? `Correlation: ${displayNameA} vs ${displayNameB}`
                  : 'Cross-Metric Correlation'}
              </h2>
              <p className="text-xs text-slate-400">
                Descriptive statistical association between two metrics
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Metric Selection Form */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5 bg-slate-800/40 p-4 rounded-xl border border-slate-800">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Metric A (X-Axis)
            </label>
            <select
              value={metricTypeA}
              onChange={(e) => setMetricTypeA(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              {metricDefinitions.map((d) => (
                <option
                  key={d.metricType}
                  value={d.metricType}
                  disabled={d.metricType === metricTypeB}
                >
                  {d.displayName} ({d.unit || d.valueType})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Metric B (Y-Axis)
            </label>
            <select
              value={metricTypeB}
              onChange={(e) => setMetricTypeB(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              {metricDefinitions.map((d) => (
                <option
                  key={d.metricType}
                  value={d.metricType}
                  disabled={d.metricType === metricTypeA}
                >
                  {d.displayName} ({d.unit || d.valueType})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Window Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5 px-1">
          <div className="flex items-center space-x-2">
            <span className="text-xs text-slate-400 font-medium">Time Window:</span>
            {[30, 90, 180, 365].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setWindowDays(d)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                  windowDays === d
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="number"
              min={7}
              max={3650}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(1, parseInt(e.target.value) || 90))}
              className="w-20 bg-slate-800 border border-slate-700 text-slate-200 rounded-md px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
            <span className="text-xs text-slate-400">days</span>
            <button
              onClick={fetchCorrelation}
              disabled={isLoading || metricTypeA === metricTypeB}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md transition-colors disabled:opacity-50"
              title="Refresh calculation"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="mb-5 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-200">Error</p>
              <p className="text-xs text-red-300/90 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="py-12 flex flex-col items-center justify-center space-y-3">
            <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
            <p className="text-sm text-slate-400">Calculating cross-metric correlation...</p>
          </div>
        )}

        {/* Same Metric Warning */}
        {metricTypeA && metricTypeB && metricTypeA === metricTypeB && (
          <div className="p-5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm text-center">
            Please select two different metrics to calculate cross-metric correlation.
          </div>
        )}

        {/* Results View */}
        {!isLoading && correlation && metricTypeA !== metricTypeB && (
          <div className="space-y-5">
            {correlation.ok ? (
              <>
                {/* Summary Card */}
                <div
                  className={`p-4 rounded-xl border ${
                    correlation.hasClearCorrelation
                      ? correlation.correlationCoefficient > 0
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                        : 'bg-indigo-950/30 border-indigo-500/30 text-indigo-200'
                      : 'bg-slate-800/40 border-slate-700/60 text-slate-200'
                  }`}
                >
                  <div className="flex items-center space-x-3 mb-2">
                    {correlation.hasClearCorrelation ? (
                      correlation.correlationCoefficient > 0 ? (
                        <TrendingUp className="w-5 h-5 text-emerald-400 shrink-0" />
                      ) : (
                        <TrendingDown className="w-5 h-5 text-indigo-400 shrink-0" />
                      )
                    ) : (
                      <Minus className="w-5 h-5 text-slate-400 shrink-0" />
                    )}
                    <span className="font-medium text-sm">
                      {correlation.hasClearCorrelation
                        ? `Correlation between ${correlation.displayNameA} and ${correlation.displayNameB}: r = ${correlation.correlationCoefficient} (n = ${correlation.sampleSize} paired days over last ${correlation.windowDays} days).`
                        : `No clear correlation found between ${correlation.displayNameA} and ${correlation.displayNameB} (r = ${correlation.correlationCoefficient}, n = ${correlation.sampleSize} paired days over last ${correlation.windowDays} days).`}
                    </span>
                  </div>
                </div>

                {/* Scatter Plot */}
                {correlation.pairedDailyAverages.length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-800 rounded-xl p-4">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                      Aligned Daily Means ({correlation.displayNameA} vs {correlation.displayNameB})
                    </h3>
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart
                          margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                          <XAxis
                            type="number"
                            dataKey="valueA"
                            name={correlation.displayNameA}
                            unit={correlation.unitA ? ` ${correlation.unitA}` : ''}
                            stroke="#94a3b8"
                            fontSize={11}
                            tickLine={false}
                          />
                          <YAxis
                            type="number"
                            dataKey="valueB"
                            name={correlation.displayNameB}
                            unit={correlation.unitB ? ` ${correlation.unitB}` : ''}
                            stroke="#94a3b8"
                            fontSize={11}
                            tickLine={false}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload;
                                return (
                                  <div className="bg-slate-900 border border-slate-700 px-3 py-2 rounded-lg shadow-xl text-xs space-y-1">
                                    <div className="font-medium text-slate-400">{data.day}</div>
                                    <div className="text-cyan-300">
                                      {correlation.displayNameA}: {data.valueA} {correlation.unitA || ''}
                                    </div>
                                    <div className="text-purple-300">
                                      {correlation.displayNameB}: {data.valueB} {correlation.unitB || ''}
                                    </div>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Scatter
                            name="Paired Daily Means"
                            data={correlation.pairedDailyAverages}
                            fill="#38bdf8"
                          />
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Insufficient Data State */
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm flex items-start space-x-3">
                <HelpCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-amber-100">Insufficient Data</p>
                  <p className="text-xs text-amber-200/90 mt-1">
                    Insufficient paired data to compute correlation between{' '}
                    {correlation.displayNameA} and {correlation.displayNameB}. Found{' '}
                    {correlation.sampleSize} days where both metrics were recorded in the last{' '}
                    {correlation.windowDays} days (minimum required: {correlation.minRequired}).
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Methodology / Disclaimer Footer */}
        <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
          <p className="text-xs text-slate-500">
            Correlation describes statistical association in your trailing data and does not imply causation.
          </p>
        </div>
      </div>
    </div>
  );
};

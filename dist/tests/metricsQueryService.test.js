"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const metricsQueryService_1 = require("../src/services/metricsQueryService");
describe('Metrics Canonical Query Path', () => {
    test('reconciled data stream overrides raw stream for overlapping time window', () => {
        const startTime = new Date('2026-08-01T10:00:00Z');
        const endTime = new Date('2026-08-01T10:05:00Z');
        const rawEntry = {
            userId: 'user-1',
            provider: 'google_health',
            metricType: 'heart_rate',
            externalId: 'raw-point-1',
            startTime,
            endTime,
            valueNumeric: 72,
            unit: 'bpm',
            sourceStream: 'raw',
            aggregation: 'raw',
        };
        const reconciledEntry = {
            userId: 'user-1',
            provider: 'google_health',
            metricType: 'heart_rate',
            startTime,
            endTime,
            valueNumeric: 70, // Reconciled value takes precedence
            unit: 'bpm',
            sourceStream: 'reconciled',
            aggregation: '5m_avg',
        };
        const combined = [rawEntry, reconciledEntry];
        const filtered = (0, metricsQueryService_1.filterReconciledOverRaw)(combined);
        expect(filtered.length).toBe(1);
        expect(filtered[0].sourceStream).toBe('reconciled');
        expect(filtered[0].valueNumeric).toBe(70);
    });
});

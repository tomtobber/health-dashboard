import { NormalizedMetricEntry } from '../adapters/baseAdapter';
export interface MetricQueryFilter {
    userId: string;
    metricType: string;
    startTime: Date;
    endTime: Date;
}
export interface MetricEntryWithDelete extends NormalizedMetricEntry {
    deletedAt?: Date | null;
}
export declare function filterReconciledOverRaw(entries: MetricEntryWithDelete[]): NormalizedMetricEntry[];

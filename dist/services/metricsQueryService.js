"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterReconciledOverRaw = filterReconciledOverRaw;
function filterReconciledOverRaw(entries) {
    const activeEntries = entries.filter((e) => !e.deletedAt);
    const reconciledMap = new Map();
    const rawEntries = [];
    for (const entry of activeEntries) {
        if (entry.sourceStream === 'reconciled') {
            const key = `${entry.startTime.toISOString()}-${entry.endTime.toISOString()}`;
            reconciledMap.set(key, entry);
        }
        else {
            rawEntries.push(entry);
        }
    }
    const result = Array.from(reconciledMap.values());
    for (const raw of rawEntries) {
        const rawKey = `${raw.startTime.toISOString()}-${raw.endTime.toISOString()}`;
        if (!reconciledMap.has(rawKey)) {
            result.push(raw);
        }
    }
    return result.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

import { describe, test, expect } from '@jest/globals';
import { evaluateAndRunDueSyncs } from '../src/services/dueCheckService';

describe('State-Driven Due-Check Evaluator', () => {
  test('evaluateAndRunDueSyncs runs without error and returns structured execution summary', async () => {
    const summary = await evaluateAndRunDueSyncs({
      pollingIntervalHours: 1,
      reconciliationIntervalHours: 24,
    });

    expect(summary).toHaveProperty('evaluatedAccounts');
    expect(summary).toHaveProperty('pollingExecuted');
    expect(summary).toHaveProperty('reconciliationExecuted');
    expect(summary).toHaveProperty('healthChecksExecuted');
    expect(Array.isArray(summary.errors)).toBe(true);
  });
});

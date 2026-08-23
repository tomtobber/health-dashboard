import { pool } from '../src/db/index';
import { logger } from '../src/utils/logger';

export async function convertBloodGlucoseEntries(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    logger.info('Starting standalone conversion of existing blood-glucose entries...');

    const result = await client.query(`
      UPDATE metric_entries
      SET
        dimension = COALESCE(
          LOWER(raw_payload->'bloodGlucose'->>'measurementTiming'),
          LOWER(raw_payload->'blood-glucose'->>'measurementTiming'),
          dimension
        ),
        value_numeric = COALESCE(
          (raw_payload->'bloodGlucose'->>'bloodGlucoseMilligramsPerDeciliter')::double precision,
          (raw_payload->'blood-glucose'->>'bloodGlucoseMilligramsPerDeciliter')::double precision,
          (raw_payload->'bloodGlucose'->>'bloodGlucoseMmolPerLiter')::double precision * 18.018,
          (raw_payload->'blood-glucose'->>'bloodGlucoseMmolPerLiter')::double precision * 18.018,
          value_numeric
        ),
        value_text = CASE
          WHEN (raw_payload->'bloodGlucose'->>'bloodGlucoseMilligramsPerDeciliter') IS NOT NULL
            THEN ROUND(((raw_payload->'bloodGlucose'->>'bloodGlucoseMilligramsPerDeciliter')::numeric / 18.018), 1)::text || ' mmol/L'
          WHEN (raw_payload->'blood-glucose'->>'bloodGlucoseMilligramsPerDeciliter') IS NOT NULL
            THEN ROUND(((raw_payload->'blood-glucose'->>'bloodGlucoseMilligramsPerDeciliter')::numeric / 18.018), 1)::text || ' mmol/L'
          WHEN value_numeric IS NOT NULL
            THEN ROUND((value_numeric::numeric / 18.018), 1)::text || ' mmol/L'
          ELSE value_text
        END,
        unit = COALESCE(unit, 'mg/dL')
      WHERE
        metric_type IN ('blood-glucose', 'blood_glucose')
        AND raw_payload IS NOT NULL;
    `);

    await client.query('COMMIT');
    logger.info(`Successfully converted ${result.rowCount ?? 0} blood-glucose entries.`);
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    logger.error('Failed to convert blood-glucose entries', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  convertBloodGlucoseEntries()
    .then(() => {
      console.log('Conversion script completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Conversion script failed:', err);
      process.exit(1);
    });
}

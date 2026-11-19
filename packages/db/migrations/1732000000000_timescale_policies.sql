-- Up Migration

-- Compression: segment by the columns that appear in the unique index.
ALTER TABLE check_results SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'monitor_id, region',
  timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('check_results', INTERVAL '7 days');
SELECT add_retention_policy('check_results', INTERVAL '90 days');

-- 1-minute continuous aggregate (real-time: also includes not-yet-materialized rows).
-- WITH NO DATA is required because migrations run inside a transaction.
CREATE MATERIALIZED VIEW check_stats_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 minute', time) AS bucket,
       monitor_id,
       region,
       count(*)                          AS checks,
       count(*) FILTER (WHERE NOT ok)    AS failures,
       sum(latency_ms)                   AS latency_sum,
       count(latency_ms)                 AS latency_n,
       max(latency_ms)                   AS max_latency_ms
FROM check_results
GROUP BY bucket, monitor_id, region
WITH NO DATA;

SELECT add_continuous_aggregate_policy('check_stats_1m',
  start_offset      => INTERVAL '2 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- Down Migration
SELECT remove_continuous_aggregate_policy('check_stats_1m');
DROP MATERIALIZED VIEW check_stats_1m;
SELECT remove_retention_policy('check_results');
SELECT remove_compression_policy('check_results');
ALTER TABLE check_results SET (timescaledb.compress = false);

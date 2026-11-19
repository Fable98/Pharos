-- Up Migration
CREATE TABLE check_results (
  time timestamptz NOT NULL,
  monitor_id uuid NOT NULL,
  region text NOT NULL DEFAULT 'primary',
  ok boolean NOT NULL,
  status_code smallint,
  latency_ms int,
  dns_ms int,
  tcp_ms int,
  tls_ms int,
  ttfb_ms int,
  error_code text
);

SELECT create_hypertable('check_results', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE UNIQUE INDEX check_results_monitor_region_time_idx ON check_results (monitor_id, region, time);
CREATE INDEX check_results_monitor_time_idx ON check_results (monitor_id, time DESC);

-- Down Migration
DROP TABLE check_results;

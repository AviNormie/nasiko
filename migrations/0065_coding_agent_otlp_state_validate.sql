-- Validate the widened `otlp_state` check added NOT VALID by 0064. Its own migration because
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE: reads and writes continue while it scans,
-- which they would not inside 0064's transaction, still holding that migration's exclusive lock.
ALTER TABLE coding_agent_telemetry_events
    VALIDATE CONSTRAINT coding_agent_telemetry_events_otlp_state_check;

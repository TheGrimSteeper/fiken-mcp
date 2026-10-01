// Keep the limiter fast in unit tests; limiter.test.ts sets its own values.
process.env.FIKEN_MIN_INTERVAL_MS ??= "0";
process.env.FIKEN_RETRY_BASE_MS ??= "0";

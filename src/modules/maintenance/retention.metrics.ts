/**
 * Tiny self-contained counter for the retention cleanup job. This intentionally avoids
 * wiring a global metrics system (Prometheus, OpenTelemetry, etc.): it is a single
 * in-module counter that a future metrics exporter can read, and that tests can assert on.
 *
 * `retentionDeletedTotal` is a monotonically increasing count of `sms_messages` rows
 * purged by the retention job over the lifetime of the process.
 */
export interface RetentionMetrics {
  retentionDeletedTotal: number;
}

export const retentionMetrics: RetentionMetrics = {
  retentionDeletedTotal: 0,
};

/**
 * Increment the purged-messages counter. No-ops for non-positive deltas so a zero-delete
 * run leaves the counter untouched.
 */
export function incrementRetentionDeleted(count: number): void {
  if (Number.isFinite(count) && count > 0) {
    retentionMetrics.retentionDeletedTotal += count;
  }
}

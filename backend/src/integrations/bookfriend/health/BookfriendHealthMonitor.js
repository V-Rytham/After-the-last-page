export class BookfriendHealthMonitor {
  constructor({ threshold = 4 } = {}) { this.threshold = threshold; this.failures = 0; this.degraded = false; }
  onSuccess() { this.failures = 0; this.degraded = false; }
  onFailure() { this.failures += 1; if (this.failures >= this.threshold) this.degraded = true; }
  snapshot() { return { degraded: this.degraded, consecutiveFailures: this.failures, threshold: this.threshold }; }
}

function bytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function reduction(fullBytes, deliveredBytes) {
  const savedBytes = Math.max(0, fullBytes - deliveredBytes);
  return {
    fullBytes,
    deliveredBytes,
    savedBytes,
    reductionPercent: fullBytes === 0 ? 0 : Number(((savedBytes / fullBytes) * 100).toFixed(1)),
  };
}

/** Exact, in-memory accounting for one MCP session. No token estimates are used. */
export class AccelerationStats {
  constructor({ sessionManager }) {
    this.session = sessionManager;
    this.files = { reads: 0, fullBytes: 0, deliveredBytes: 0 };
    this.commands = { runs: 0, rawBytes: 0, compactBytes: 0 };
  }

  recordFileDelivery(delivery) {
    if (!delivery) return;
    this.files.reads++;
    this.files.fullBytes += bytes(delivery.fullSourceBytes);
    this.files.deliveredBytes += bytes(delivery.deliveredTextBytes);
  }

  recordCommand({ rawBytes, compactBytes, runs = 1 } = {}) {
    this.commands.runs += bytes(runs);
    this.commands.rawBytes += bytes(rawBytes);
    this.commands.compactBytes += bytes(compactBytes);
  }

  snapshot() {
    const source = reduction(this.files.fullBytes, this.files.deliveredBytes);
    const diagnostics = reduction(this.commands.rawBytes, this.commands.compactBytes);
    return {
      schemaVersion: 1,
      scope: { kind: 'session' },
      source: { reads: this.files.reads, ...source },
      commands: { runs: this.commands.runs, rawDiagnosticOutputBytes: diagnostics.fullBytes, compactDiagnosticBytes: diagnostics.deliveredBytes, savedBytes: diagnostics.savedBytes, reductionPercent: diagnostics.reductionPercent },
    };
  }
}

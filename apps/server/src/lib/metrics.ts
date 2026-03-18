export interface MetricsSnapshot {
  activeRooms: number;
  activeConnections: number;
  reconnects: number;
  timeoutAutoActions: number;
  emittedErrors: number;
}

export class MetricsTracker {
  private snapshot: MetricsSnapshot = {
    activeRooms: 0,
    activeConnections: 0,
    reconnects: 0,
    timeoutAutoActions: 0,
    emittedErrors: 0,
  };

  setActiveRooms(count: number): void {
    this.snapshot.activeRooms = count;
  }

  setActiveConnections(count: number): void {
    this.snapshot.activeConnections = count;
  }

  incrementReconnects(): void {
    this.snapshot.reconnects += 1;
  }

  incrementTimeoutAutoActions(): void {
    this.snapshot.timeoutAutoActions += 1;
  }

  incrementErrors(): void {
    this.snapshot.emittedErrors += 1;
  }

  getSnapshot(): MetricsSnapshot {
    return { ...this.snapshot };
  }
}

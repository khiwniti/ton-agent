/**
 * Direct Lite Client — Direct TON Lite Client connection for low-latency reads.
 * Feature-flagged via CONFIG.liteClientEnabled. Minimal implementation for now.
 */
export class DirectLiteClient {
  private connected: boolean = false;
  private lastBlock: number = 0;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly adnlEndpoint: string,
    private readonly httpEndpoint: string,
    private readonly timeoutMs: number,
    private readonly maxRetries: number
  ) {}

  async start(): Promise<void> {
    // Placeholder - would establish ADNL connection
    this.connected = true;
    this.lastBlock = Date.now();
    console.log("[LITE] DirectLiteClient started (placeholder)");
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log("[LITE] DirectLiteClient stopped");
  }

  getStatus(): { connected: boolean; lastBlock: number } {
    return {
      connected: this.connected,
      lastBlock: this.lastBlock,
    };
  }
}
import { ModelTrainer } from "./training";
import { PredictionService } from "./prediction-service";

/**
 * Retraining Scheduler — Periodically retrains ML models.
 * Feature-flagged via CONFIG.mlEnabled. Minimal implementation for now.
 */
export class RetrainingScheduler {
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelTrainer: ModelTrainer,
    private readonly predictionService: PredictionService,
    private readonly intervalHours: number
  ) {}

  start(): void {
    if (this.intervalId) return;

    const intervalMs = this.intervalHours * 60 * 60 * 1000;

    this.intervalId = setInterval(async () => {
      try {
        await this.modelTrainer.train();
        // In a real implementation, we'd update the prediction service with the new model
        console.log("[ML] Retraining completed");
      } catch (e: any) {
        console.error("[ML] Retraining failed:", e.message);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
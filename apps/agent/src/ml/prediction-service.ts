import { PredictionService as IPredictionService, PredictionResult, FeatureVector, ModelConfig } from "./types";

/**
 * Prediction Service — ML-based price prediction for sniper entries/exits.
 * Feature-flagged via CONFIG.mlEnabled. Minimal implementation for now.
 */
export class PredictionService {
  private cache = new Map<string, { result: PredictionResult; expiresAt: number }>();
  private modelConfig: ModelConfig | null = null;

  constructor(
    private readonly confidenceThreshold: number,
    private readonly cacheTTLSeconds: number
  ) {}

  async predict(features: Record<string, number>): Promise<PredictionResult> {
    const cacheKey = JSON.stringify(features);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    // Minimal placeholder - returns neutral signal
    const result: PredictionResult = {
      signal: "hold",
      confidence: 0,
      expectedReturn: 0,
      features: {
        timestamp: Date.now(),
        features,
      },
      modelVersion: this.modelConfig?.version || "none",
      timestamp: Date.now(),
    };

    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.cacheTTLSeconds * 1000,
    });

    return result;
  }

  getCachedPrediction(key: string): PredictionResult | undefined {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    return undefined;
  }

  setCachedPrediction(key: string, result: PredictionResult): void {
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.cacheTTLSeconds * 1000,
    });
  }

  setModelConfig(config: ModelConfig): void {
    this.modelConfig = config;
  }

  stop(): void {
    this.cache.clear();
    this.modelConfig = null;
  }
}
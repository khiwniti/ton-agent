import { PredictionResult, ModelConfig, OhlcvData } from "./types";

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

  async predict(candles: OhlcvData): Promise<PredictionResult> {
    // Flatten the candle series into a stable cache key (feature dict).
    const features: Record<string, number> = {
      lastClose: candles.close[candles.close.length - 1] ?? 0,
      lastOpen: candles.open[candles.open.length - 1] ?? 0,
      lastHigh: candles.high[candles.high.length - 1] ?? 0,
      lastLow: candles.low[candles.low.length - 1] ?? 0,
      lastVolume: candles.volume[candles.volume.length - 1] ?? 0,
      nCandles: candles.close.length,
    };
    const cacheKey = JSON.stringify(features);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    // Minimal placeholder - returns neutral signal
    const lastClose = features.lastClose;
    const lastOpen = features.lastOpen;
    const lastHigh = features.lastHigh;
    const lastLow = features.lastLow;
    const lastVolume = features.lastVolume;
    const result: PredictionResult = {
      signal: "hold",
      confidence: 0,
      expectedReturn: 0,
      features: {
        timestamp: Date.now(),
        rsi: 50,
        macd: 0,
        macdSignal: 0,
        macdHistogram: 0,
        bollingerUpper: lastClose * 1.02,
        bollingerMiddle: lastClose,
        bollingerLower: lastClose * 0.98,
        sma20: lastClose,
        sma50: lastClose,
        ema12: lastClose,
        ema26: lastClose,
        volumeSma20: lastVolume,
        obv: 0,
        atr: lastClose * 0.02,
        stochasticK: 50,
        stochasticD: 50,
        roc: 0,
        open: lastOpen,
        high: lastHigh,
        low: lastLow,
        close: lastClose,
        volume: lastVolume,
        priceChange: 0,
        priceChangePercent: 0,
        volumeChange: 0,
        volumeChangePercent: 0,
        volatility: 0.02,
        trendStrength: 0.5,
        marketMomentum: 0,
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
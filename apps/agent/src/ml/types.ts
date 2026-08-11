/** ML module type definitions */
export interface FeatureVector {
  timestamp: number;
  /** Technical indicator set computed by FeatureEngine (features.ts). */
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  sma20: number;
  sma50: number;
  ema12: number;
  ema26: number;
  volumeSma20: number;
  obv: number;
  atr: number;
  stochasticK: number;
  stochasticD: number;
  roc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  priceChange: number;
  priceChangePercent: number;
  volumeChange: number;
  volumeChangePercent: number;
  volatility: number;
  trendStrength: number;
  marketMomentum: number;
  features: Record<string, number>;
}

/** Raw OHLCV candles consumed by PredictionService.predict / FeatureEngine. */
export interface OhlcvData {
  timestamp: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/** PredictionService contract — implemented by prediction-service.ts. */
export abstract class PredictionService {
  abstract predict(candles: OhlcvData): Promise<PredictionResult>;
  abstract getCachedPrediction(key: string): PredictionResult | undefined;
  abstract setCachedPrediction(key: string, result: PredictionResult): void;
  abstract setModelConfig(config: ModelConfig): void;
  abstract stop(): void;
}

/** ML price prediction returned to fastpath-engine / callers. */
export interface ModelPrediction {
  direction: "up" | "down" | "sideways";
  confidence: number;
  predictedChangePercent: number;
}

export interface PredictionResult {
  signal: "buy" | "sell" | "hold";
  confidence: number;
  expectedReturn: number;
  features: FeatureVector;
  modelVersion: string;
  timestamp: number;
}

export interface ModelConfig {
  version: string;
  features: string[];
  threshold: number;
  trainedAt: number;
}

export interface TrainingMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  loss: number;
  samples: number;
}
/** ML module type definitions */
export interface FeatureVector {
  timestamp: number;
  features: Record<string, number>;
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
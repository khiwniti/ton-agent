/**
 * Feature engineering pipeline for ML-based price prediction
 * Computes technical indicators from OHLCV data for model input
 */

import { log } from "../logger";
import { FeatureVector } from "./types";

/**
 * FeatureEngine computes technical indicators and builds feature vectors
 */
export class FeatureEngine {
  private windowSize: number;
  
  constructor(windowSize: number = 100) {
    this.windowSize = windowSize;
    log.info("ML_FEATURES", `FeatureEngine initialized with window size: ${windowSize}`);
  }
  
  /**
   * Get window size
   */
  public getWindowSize(): number {
    return this.windowSize;
  }
  
  /**
   * Calculate Simple Moving Average (SMA)
   */
  private sma(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(0);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result[i] = sum / period;
    }
    return result;
  }
  
  /**
   * Calculate Exponential Moving Average (EMA)
   */
  private ema(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(0);
    const multiplier = 2 / (period + 1);
    
    result[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      result[i] = (data[i] - result[i-1]) * multiplier + result[i-1];
    }
    return result;
  }
  
  /**
   * Calculate Relative Strength Index (RSI)
   */
  private rsi(data: number[], period: number): number[] {
    const gains: number[] = new Array(data.length).fill(0);
    const losses: number[] = new Array(data.length).fill(0);
    
    for (let i = 1; i < data.length; i++) {
      const change = data[i] - data[i-1];
      gains[i] = Math.max(change, 0);
      losses[i] = Math.max(-change, 0);
    }
    
    const avgGain = this.sma(gains, period);
    const avgLoss = this.sma(losses, period);
    
    const result: number[] = new Array(data.length).fill(0);
    for (let i = period; i < data.length; i++) {
      if (avgLoss[i] === 0) {
        result[i] = 100;
      } else {
        const rs = avgGain[i] / avgLoss[i];
        result[i] = 100 - (100 / (1 + rs));
      }
    }
    return result;
  }
  
  /**
   * Calculate Moving Average Convergence Divergence (MACD)
   */
  private macd(data: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
    const ema12 = this.ema(data, 12);
    const ema26 = this.ema(data, 26);
    
    const macdLine: number[] = new Array(data.length).fill(0);
    const signalLine: number[] = new Array(data.length).fill(0);
    const histogram: number[] = new Array(data.length).fill(0);
    
    for (let i = 0; i < data.length; i++) {
      macdLine[i] = ema12[i] - ema26[i];
    }
    
    // Signal line is EMA of MACD line
    for (let i = 0; i < macdLine.length; i++) {
      if (i === 0) {
        signalLine[i] = macdLine[i];
      } else {
        signalLine[i] = (macdLine[i] - signalLine[i-1]) * 0.2 + signalLine[i-1];
      }
      histogram[i] = macdLine[i] - signalLine[i];
    }
    
    return { macd: macdLine, signal: signalLine, histogram: histogram };
  }
  
  /**
   * Calculate Bollinger Bands
   */
  private bollingerBands(data: number[], period: number, stdDev: number): { 
    upper: number[]; 
    middle: number[]; 
    lower: number[] 
  } {
    const sma = this.sma(data, period);
    const std: number[] = new Array(data.length).fill(0);
    
    // Calculate standard deviation
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        const diff = data[i - j] - sma[i];
        sum += diff * diff;
      }
      std[i] = Math.sqrt(sum / period);
    }
    
    const upper: number[] = new Array(data.length).fill(0);
    const lower: number[] = new Array(data.length).fill(0);
    
    for (let i = 0; i < data.length; i++) {
      upper[i] = sma[i] + (std[i] * stdDev);
      lower[i] = sma[i] - (std[i] * stdDev);
    }
    
    return { upper, middle: sma, lower };
  }
  
  /**
   * Calculate On-Balance Volume (OBV)
   */
  private obv(close: number[], volume: number[]): number[] {
    const result: number[] = new Array(close.length).fill(0);
    
    for (let i = 1; i < close.length; i++) {
      if (close[i] > close[i-1]) {
        result[i] = result[i-1] + volume[i];
      } else if (close[i] < close[i-1]) {
        result[i] = result[i-1] - volume[i];
      } else {
        result[i] = result[i-1];
      }
    }
    return result;
  }
  
  /**
   * Calculate Average True Range (ATR)
   */
  private atr(high: number[], low: number[], close: number[], period: number): number[] {
    const tr: number[] = new Array(high.length).fill(0);
    
    for (let i = 0; i < high.length; i++) {
      const highLow = high[i] - low[i];
      const highClose = Math.abs(high[i] - (i > 0 ? close[i-1] : high[i]));
      const lowClose = Math.abs(low[i] - (i > 0 ? close[i-1] : low[i]));
      tr[i] = Math.max(highLow, highClose, lowClose);
    }
    
    // ATR is SMA of TR
    return this.sma(tr, period);
  }
  
  /**
   * Calculate Stochastic Oscillator
   */
  private stochastic(high: number[], low: number[], close: number[], 
                    kPeriod: number, dPeriod: number): { 
    k: number[]; 
    d: number[] 
  } {
    const k: number[] = new Array(close.length).fill(0);
    
    for (let i = kPeriod - 1; i < high.length; i++) {
      let lowestLow = low[i];
      let highestHigh = high[i];
      
      for (let j = 1; j < kPeriod; j++) {
        if (low[i - j] < lowestLow) lowestLow = low[i - j];
        if (high[i - j] > highestHigh) highestHigh = high[i - j];
      }
      
      if (highestHigh !== lowestLow) {
        k[i] = ((close[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
      } else {
        k[i] = 50; // Avoid division by zero
      }
    }
    
    // D is SMA of K
    const d: number[] = this.sma(k, dPeriod);
    
    return { k, d };
  }
  
  /**
   * Calculate Rate of Change (ROC)
   */
  private roc(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(0);
    
    for (let i = period; i < data.length; i++) {
      if (data[i - period] !== 0) {
        result[i] = ((data[i] - data[i - period]) / data[i - period]) * 100;
      } else {
        result[i] = 0;
      }
    }
    return result;
  }
  
  /**
   * Build feature vector from OHLCV data
   */
  public buildFeatureVector(
    ohlcvData: { 
      timestamp: number[]; 
      open: number[]; 
      high: number[]; 
      low: number[]; 
      close: number[]; 
      volume: number[] 
    },
    index: number
  ): FeatureVector | null {
    // Check if we have enough data
    if (index < this.windowSize - 1) {
      return null;
    }
    
    // Extract data windows
    const windowStart = index - this.windowSize + 1;
    const windowEnd = index + 1;
    
    const window = {
      timestamp: ohlcvData.timestamp.slice(windowStart, windowEnd),
      open: ohlcvData.open.slice(windowStart, windowEnd),
      high: ohlcvData.high.slice(windowStart, windowEnd),
      low: ohlcvData.low.slice(windowStart, windowEnd),
      close: ohlcvData.close.slice(windowStart, windowEnd),
      volume: ohlcvData.volume.slice(windowStart, windowEnd)
    };
    
    try {
      // Calculate technical indicators
      const rsiValues = this.rsi(window.close, 14);
      const macdResult = this.macd(window.close);
      const bbResult = this.bollingerBands(window.close, 20, 2);
      const sma20 = this.sma(window.close, 20);
      const sma50 = this.sma(window.close, 50);
      const ema12 = this.ema(window.close, 12);
      const ema26 = this.ema(window.close, 26);
      const volumeSma20 = this.sma(window.volume, 20);
      const obvValues = this.obv(window.close, window.volume);
      const atrValues = this.atr(window.high, window.low, window.close, 14);
      const stochResult = this.stochastic(window.high, window.low, window.close, 14, 3);
      const rocValues = this.roc(window.close, 10);
      
      // Calculate derived features
      const priceChange = window.close[window.close.length - 1] - 
                         window.close[window.close.length - 2];
      const priceChangePercent = (priceChange / window.close[window.close.length - 2]) * 100;
      
      const volumeChange = window.volume[window.volume.length - 1] - 
                          window.volume[window.volume.length - 2];
      const volumeChangePercent = (volumeChange / window.volume[window.volume.length - 2]) * 100;
      
      // Calculate market regime features
      const volatility = atrValues[atrValues.length - 1] / 
                        window.close[window.close.length - 1];
      
      const trendStrength = Math.abs(sma20[sma20.length - 1] - sma50[sma50.length - 1]) / 
                           window.close[window.close.length - 1];
      
      const marketMomentum = rocValues[rocValues.length - 1];
      
      // Build feature vector
      const featureVector: FeatureVector = {
        timestamp: window.timestamp[window.timestamp.length - 1],
        
        // Technical indicators
        rsi: rsiValues[rsiValues.length - 1],
        macd: macdResult.macd[macdResult.macd.length - 1],
        macdSignal: macdResult.signal[macdResult.signal.length - 1],
        macdHistogram: macdResult.histogram[macdResult.histogram.length - 1],
        bollingerUpper: bbResult.upper[bbResult.upper.length - 1],
        bollingerMiddle: bbResult.middle[bbResult.middle.length - 1],
        bollingerLower: bbResult.lower[bbResult.lower.length - 1],
        sma20: sma20[sma20.length - 1],
        sma50: sma50[sma50.length - 1],
        ema12: ema12[ema12.length - 1],
        ema26: ema26[ema26.length - 1],
        volumeSma20: volumeSma20[volumeSma20.length - 1],
        obv: obvValues[obvValues.length - 1],
        atr: atrValues[atrValues.length - 1],
        stochasticK: stochResult.k[stochResult.k.length - 1],
        stochasticD: stochResult.d[stochResult.d.length - 1],
        roc: rocValues[rocValues.length - 1],
        
        // Price and volume data
        open: window.open[window.open.length - 1],
        high: window.high[window.high.length - 1],
        low: window.low[window.low.length - 1],
        close: window.close[window.close.length - 1],
        volume: window.volume[window.volume.length - 1],
        
        // Derived features
        priceChange: priceChange,
        priceChangePercent: priceChangePercent,
        volumeChange: volumeChange,
        volumeChangePercent: volumeChangePercent,
        
        // Market regime features
        volatility: volatility,
        trendStrength: trendStrength,
        marketMomentum: marketMomentum
      };
      
      return featureVector;
    } catch (error) {
      log.warn("ML_FEATURES", `Error building feature vector: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  
  /**
   * Get feature names for documentation
   */
  public static getFeatureNames(): string[] {
    return [
      "timestamp",
      "rsi", "macd", "macdSignal", "macdHistogram",
      "bollingerUpper", "bollingerMiddle", "bollingerLower",
      "sma20", "sma50", "ema12", "ema26",
      "volumeSma20", "obv", "atr",
      "stochasticK", "stochasticD", "roc",
      "open", "high", "low", "close", "volume",
      "priceChange", "priceChangePercent",
      "volumeChange", "volumeChangePercent",
      "volatility", "trendStrength", "marketMomentum"
    ];
  }
}

export function calculateEMA(data: number[], period: number): number {
  if (!data || data.length === 0) return 0;
  const multiplier = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

export function calculateSMA(data: number[], period: number): number {
  if (!data || data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(data.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calculateRSI(data: number[], period: number = 14): number {
  if (!data || data.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calculateMACD(data: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: number; signal: number; histogram: number } {
  const fastEma = calculateEMA(data, fast);
  const slowEma = calculateEMA(data, slow);
  const macdVal = fastEma - slowEma;
  const signalVal = macdVal * (2 / (signalPeriod + 1));
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

export function calculateBollingerBands(data: number[], period = 20, stdDevMultiplier = 2): { upper: number; middle: number; lower: number } {
  const sma = calculateSMA(data, period);
  const slice = data.slice(Math.max(0, data.length - period));
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  return {
    upper: sma + stdDev * stdDevMultiplier,
    middle: sma,
    lower: sma - stdDev * stdDevMultiplier,
  };
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (!highs || highs.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  return calculateSMA(trs, Math.min(period, trs.length));
}

export function extractFeaturesFromCandles(candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>): FeatureVector {
  const engine = new FeatureEngine(candles.length);
  const window = {
    timestamp: candles.map((c) => c.timestamp),
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
  };
  const fv = engine.buildFeatureVector(window, candles.length - 1);
  if (fv) return fv;

  const closes = window.close;
  const lastClose = closes[closes.length - 1] || 1;
  return {
    timestamp: Date.now(),
    rsi: calculateRSI(closes, 14),
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
    volumeSma20: 1000,
    obv: 0,
    atr: lastClose * 0.02,
    stochasticK: 50,
    stochasticD: 50,
    roc: 0,
    open: window.open[window.open.length - 1] || lastClose,
    high: window.high[window.high.length - 1] || lastClose,
    low: window.low[window.low.length - 1] || lastClose,
    close: lastClose,
    volume: window.volume[window.volume.length - 1] || 1000,
    priceChange: 0,
    priceChangePercent: 0,
    volumeChange: 0,
    volumeChangePercent: 0,
    volatility: 0.02,
    trendStrength: 0.5,
    marketMomentum: 0,
  };
}

/**
 * LINE Client — Placeholder for LINE messaging integration.
 * Not currently used - exported to satisfy imports.
 */
export class LineClient {
  constructor(private readonly accessToken: string) {}

  async pushMessage(userId: string, message: string): Promise<void> {
    // Placeholder
    console.log(`[LINE] Push to ${userId}: ${message}`);
  }

  async replyMessage(replyToken: string, message: string): Promise<void> {
    // Placeholder
    console.log(`[LINE] Reply: ${message}`);
  }
}

/**
 * Create a LINE client from config.
 * Returns null if not configured.
 */
export function createLineClient(): LineClient | null {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  return new LineClient(token);
}
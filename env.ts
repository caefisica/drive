import { defineEnv, string } from "void/env";

export default defineEnv({
  // JSON array of DriveConfig objects (see src/config.ts)
  // [{ name, rootId, clientId, clientSecret, refreshToken }, ...]
  DRIVES: string(),

  // HMAC secret for signing stream/download tokens (1h TTL)
  STREAM_SECRET: string(),

  // HMAC secret for signing folder-unlock cookies (24h TTL)
  UNLOCK_SECRET: string(),

  // Optional: shared secret to authenticate Google Drive push notification webhooks
  WEBHOOK_SECRET: string().optional(),
});

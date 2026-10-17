import { defineEnv, string } from "void/env";

export default defineEnv({
  DRIVES: string(),
  STREAM_SECRET: string(),
  UNLOCK_SECRET: string(),
  WEBHOOK_SECRET: string().optional(),
});

import type { CloudBindings } from "void/handler";

declare module "void/handler" {
  interface CloudBindings {
    DRIVES: string;
    STREAM_SECRET: string;
    UNLOCK_SECRET: string;
    WEBHOOK_SECRET: string | undefined;
  }
}

import { defineHandler } from "void";
import { runIncrementalSync } from "../../../src/services/drive-sync";

// This endpoint receives Drive Changes notifications after manual watch registration.
export const POST = defineHandler(async (c) => {
  const channelToken = c.req.header("x-goog-channel-token");
  if (!c.env.WEBHOOK_SECRET || channelToken !== c.env.WEBHOOK_SECRET) {
    return c.body(null, 403);
  }

  const driveIdx = Number(c.req.param("driveIdx"));
  if (isNaN(driveIdx)) return c.body(null, 400);

  c.executionCtx.waitUntil(runIncrementalSync(driveIdx, c.env));

  return c.body(null, 200);
});

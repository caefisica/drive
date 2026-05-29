import type { CloudEnv } from "void";

export type DriveConfig = {
  idx: number;
  name: string;
  kind?: "my_drive" | "shared_drive" | "folder";
  rootId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type RawDriveConfig = Omit<DriveConfig, "idx">;

export function getDrives(env: CloudEnv["Bindings"]): DriveConfig[] {
  let raw: RawDriveConfig[];
  try {
    raw = JSON.parse(env.DRIVES) as RawDriveConfig[];
  } catch {
    return [];
  }
  return raw.map((d, idx) => ({ ...d, idx }));
}

export function getDrive(idx: number, env: CloudEnv["Bindings"]): DriveConfig | null {
  return getDrives(env)[idx] ?? null;
}

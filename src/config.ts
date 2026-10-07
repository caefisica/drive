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

// Loader props expose only these drive fields.
export type DriveSummary = Pick<DriveConfig, "idx" | "name" | "kind">;

export function summarizeDrive({ idx, name, kind }: DriveConfig): DriveSummary {
  return { idx, name, kind };
}

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

// Reject values beyond the safe integer range because they cannot identify a drive reliably.
export function isDriveIdx(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Accept only the canonical form so each drive has one URL and signed `d` value.
export function parseDriveIdx(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }

  const idx = Number(value);

  return isDriveIdx(idx) ? idx : null;
}

export function getDrive(idx: number, env: CloudEnv["Bindings"]): DriveConfig | null {
  return getDrives(env)[idx] ?? null;
}

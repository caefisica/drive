import { beforeAll, vi } from "vite-plus/test";

import { openPlatform } from "./platform";

// One workerd boots in 4 to 6 s on a lightly loaded host. The budget covers a host several
// times slower, and only the first file in the worker pays it.
const BOOT_TIMEOUT = 60_000;

// The files share a worker without isolation. A fresh registry keeps one file's vi.mock from
// reaching the modules another file imports.
vi.resetModules();

beforeAll(async () => {
  await openPlatform();
}, BOOT_TIMEOUT);

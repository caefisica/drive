const enc = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function hmacVerify(message: string, signature: string, secret: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(message));
}

export async function signStreamToken(
  fileId: string,
  driveIdx: number,
  secret: string,
): Promise<string> {
  const expiry = Date.now() + 3_600_000;
  const msg = `${fileId}:${driveIdx}:${expiry}`;
  const sig = await hmacSign(msg, secret);
  return btoa(JSON.stringify({ e: expiry, s: sig }));
}

export async function verifyStreamToken(
  token: string,
  fileId: string,
  driveIdx: number,
  secret: string,
): Promise<boolean> {
  let parsed: { e: number; s: string };
  try {
    parsed = JSON.parse(atob(token)) as { e: number; s: string };
  } catch {
    return false;
  }
  if (parsed.e < Date.now()) return false;
  const msg = `${fileId}:${driveIdx}:${parsed.e}`;
  return hmacVerify(msg, parsed.s, secret);
}

export type UnlockEntry = { d: number; f: string };

export type UnlockCookie = { u: UnlockEntry[]; e: number };

export async function signUnlockCookie(entries: UnlockEntry[], secret: string): Promise<string> {
  const expiry = Date.now() + 86_400_000;
  const payload: UnlockCookie = { u: entries, e: expiry };
  const msg = JSON.stringify(payload);
  const sig = await hmacSign(msg, secret);
  return btoa(JSON.stringify({ p: payload, s: sig }));
}

export async function verifyUnlockCookie(
  cookieValue: string,
  secret: string,
): Promise<UnlockCookie | null> {
  let outer: { p: UnlockCookie; s: string };
  try {
    outer = JSON.parse(atob(cookieValue)) as { p: UnlockCookie; s: string };
  } catch {
    return null;
  }
  if (outer.p.e < Date.now()) return null;
  const msg = JSON.stringify(outer.p);
  const ok = await hmacVerify(msg, outer.s, secret);
  return ok ? outer.p : null;
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2:${salt}:${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
  const [, salt] = parts;
  const computed = await hashPassword(password, salt);
  return computed === storedHash;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** Unicode-aware tokenize: lowercase + split on non-letter/number runs. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const tokens: string[] = [];
  let current = "";
  for (const char of normalized) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = "";
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeText(text: string): string {
  return tokenize(text).join(" ");
}

/** FNV-1a 64-bit over UTF-8 bytes of a feature string. */
export function fnv1a64(feature: string): bigint {
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(feature);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/** 64-bit SimHash over token features. Returns unsigned 64-bit as bigint. */
export function simHash64(text: string): bigint {
  const tokens = tokenize(text);
  const weights = new Int32Array(64);
  if (!tokens.length) return 0n;
  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      if ((hash >> BigInt(bit)) & 1n) weights[bit]! += 1;
      else weights[bit]! -= 1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint & MASK64;
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let distance = 0;
  while (x > 0n) {
    distance += Number(x & 1n);
    x >>= 1n;
  }
  return distance;
}

export function isNearDuplicate(a: bigint, b: bigint, threshold = 3): boolean {
  return hammingDistance64(a, b) <= threshold;
}

export function simHashToHex(value: bigint): string {
  return (value & MASK64).toString(16).padStart(16, "0");
}

export function simHashFromHex(hex: string): bigint {
  const cleaned = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,16}$/.test(cleaned)) return 0n;
  return BigInt(`0x${cleaned}`) & MASK64;
}

/** Sync SHA-256 hex (portable; avoids async SubtleCrypto for fingerprint API). */
function sha256HexSync(message: string): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const bytes = new TextEncoder().encode(message);
  const bitLen = BigInt(bytes.length) * 8n;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, Number(bitLen & 0xffffffffn));
  view.setUint32(withPad.length - 8, Number((bitLen >> 32n) & 0xffffffffn));

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, "0")).join("");
}

export function contentFingerprint(text: string): { contentHash: string; simHash: string } {
  const normalized = normalizeText(text);
  return {
    contentHash: sha256HexSync(normalized),
    simHash: simHashToHex(simHash64(text))
  };
}

export interface VectorizeDedupeAdapter {
  upsert(id: string, values: number[], metadata: Record<string, string>): Promise<void>;
  queryNear(values: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
}

/** Cheap bag-of-words hashed into a fixed 64-dim vector for tests/placeholder. */
export function embeddingReady(text: string): number[] {
  const dims = 64;
  const values = new Float64Array(dims);
  for (const token of tokenize(text)) {
    const hash = fnv1a64(token);
    const index = Number(hash % BigInt(dims));
    const sign = (hash >> 63n) & 1n ? -1 : 1;
    values[index]! += sign;
  }
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(values, (value) => value / norm);
}

function titleTokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const TITLE_OVERLAP_THRESHOLD = 0.55;
const DEFAULT_NEAR_DUPE_THRESHOLD = 3;

export function assignStoryCluster(input: {
  contentId: string;
  simHash: string;
  title: string;
  existing: Array<{ clusterId: string; simHash: string; title: string }>;
}): string {
  const selfHash = simHashFromHex(input.simHash);
  let best: { clusterId: string; score: number } | null = null;
  for (const item of input.existing) {
    if (!item.clusterId) continue;
    const otherHash = simHashFromHex(item.simHash);
    const near = isNearDuplicate(selfHash, otherHash, DEFAULT_NEAR_DUPE_THRESHOLD);
    const overlap = titleTokenOverlap(input.title, item.title);
    if (!near && overlap < TITLE_OVERLAP_THRESHOLD) continue;
    const score = (near ? 2 : 0) + overlap;
    if (!best || score > best.score) best = { clusterId: item.clusterId, score };
  }
  return best?.clusterId ?? input.contentId;
}

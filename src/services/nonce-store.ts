export interface NonceStore {
  has(key: string): boolean;
  set(key: string, ttlMs: number): void;
}

type NonceEntry = { expiresAt: number };

class InMemoryNonceStore implements NonceStore {
  private readonly store = new Map<string, NonceEntry>();

  constructor() {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  has(key: string) {
    const entry = this.store.get(key);
    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }

    return true;
  }

  set(key: string, ttlMs: number) {
    this.store.set(key, { expiresAt: Date.now() + ttlMs });
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}

// Production note:
// This in-memory implementation is safe only for local development or
// single-instance deployments. Replace it with Redis or another shared store
// before running multiple API instances behind a load balancer.
export const nonceStore: NonceStore = new InMemoryNonceStore();

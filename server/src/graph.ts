import type { TokenCredential } from '@azure/identity';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

/** Client Microsoft Graph minimal, en mode application (Managed Identity). */
export class GraphClient {
  constructor(
    private readonly credential: TokenCredential,
    private readonly timeZone: string,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.credential.getToken('https://graph.microsoft.com/.default');
      if (!token) throw new GraphError(401, 'no_token', 'Unable to acquire a Graph token');

      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.token}`,
          Accept: 'application/json',
          Prefer: `outlook.timezone="${this.timeZone}"`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        continue;
      }

      if (!res.ok) {
        let code = 'unknown';
        let message = res.statusText;
        try {
          const data = (await res.json()) as { error?: { code?: string; message?: string } };
          code = data.error?.code ?? code;
          message = data.error?.message ?? message;
        } catch {
          // corps non JSON
        }
        throw new GraphError(res.status, code, message);
      }

      if (res.status === 202 || res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  async getAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value: T[]; '@odata.nextLink'?: string } = await this.request('GET', next);
      items.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return items;
  }
}

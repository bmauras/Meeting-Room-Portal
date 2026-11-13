import type { TokenCredential } from '@azure/identity';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 15_000;
// Un appel sans réponse est relancé une fois : au-delà, l'utilisateur attendrait trop longtemps.
const MAX_TIMEOUT_RETRIES = 1;

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
  /**
   * Requête sans effet de bord, qui peut être relancée après un délai dépassé ou une erreur réseau
   * (par défaut : GET uniquement). Jamais pour une création : elle a pu aboutir côté Exchange.
   */
  idempotent?: boolean;
}

/** Client Microsoft Graph minimal, en mode application (Managed Identity). */
export class GraphClient {
  constructor(
    private readonly credential: TokenCredential,
    private readonly timeZone: string,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    // Pour les journaux : sans la chaîne de requête.
    const target = `${method} ${url.replace(GRAPH, '').split('?')[0]}`;
    const idempotent = options.idempotent ?? method === 'GET';
    let timeouts = 0;

    for (let attempt = 0; ; attempt++) {
      let token: { token: string } | null;
      try {
        token = await this.credential.getToken('https://graph.microsoft.com/.default');
      } catch (err) {
        throw new GraphError(503, 'token_unavailable', `Managed identity: ${(err as Error).message}`);
      }
      if (!token) throw new GraphError(401, 'no_token', 'Unable to acquire a Graph token');

      // Le délai couvre aussi la lecture du corps : une réponse qui s'interrompt est traitée comme un délai dépassé.
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token.token}`,
            Accept: 'application/json',
            Prefer: `outlook.timezone="${this.timeZone}"`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await res.text();
      } catch (err) {
        const timedOut = (err as Error).name === 'TimeoutError';
        if (idempotent && timeouts < MAX_TIMEOUT_RETRIES) {
          timeouts++;
          console.warn(JSON.stringify({ type: 'graph_retry', reason: timedOut ? 'timeout' : 'network_error', target }));
          continue;
        }
        const cause = (err as { cause?: { code?: string } }).cause?.code;
        throw new GraphError(
          timedOut ? 504 : 503,
          timedOut ? 'timeout' : 'network_error',
          timedOut ? `${target}: no response after ${TIMEOUT_MS / 1000} s` : `${target}: ${cause ?? (err as Error).message}`,
        );
      }

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        continue;
      }

      if (!res.ok) {
        let code = 'unknown';
        let message = res.statusText;
        try {
          const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
          code = data.error?.code ?? code;
          message = data.error?.message ?? message;
        } catch {
          // corps non JSON
        }
        throw new GraphError(res.status, code, message);
      }

      if (res.status === 202 || res.status === 204 || !text) return undefined as T;
      return JSON.parse(text) as T;
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

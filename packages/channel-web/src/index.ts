/**
 * @wsz987/channel-web — host (Node) side.
 *
 * Cordis plugin entry for a Harness host process. Registers TWO webServer
 * prefix routes:
 *
 *  - `/dsh-channels/api/v1` — the M1 read-only dashboard + adapter auth loop
 *    (compat; doc §34). Kept intact. Talks only to `ctx.channels`.
 *  - `/dsh-channels/api/v2` — the control-plane API (doc §28–§33) that
 *    delegates to the ChannelControlService (`ctx.channelControl`). When the
 *    control plugin is absent (standalone web profile) every v2 route returns
 *    503 SERVICE_UNAVAILABLE so the profile still boots.
 *
 * The webServer / channels / channelControl services are injected via
 * ctx.inject so this plugin does not hard-depend on the web profile. The host
 * entry exports ONLY name + apply — no module-level inject export — which the
 * bundle test asserts.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChannelApi, type ChannelsLike } from './host/routes.js';
import { ChannelApiV2, type ChannelControlLike } from './host/routes-v2.js';
import { errorBody, isJsonContentType, isLoopbackAddress, readJsonBody } from './host/security.js';

export const name = 'channel-web';

/** Minimal structural view of the webServer prefix-registration surface. */
interface WebServerLike {
  register(options: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
  }): unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 204 No Content carries no response body.
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/** A read-only HTTP method — no loopback restriction (only mutations are gated). */
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Unsafe non-empty JSON media check for mutation bodies (415 otherwise). */
function isMutationWithBody(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'PUT';
}

/**
 * Build the v2 prefix handler. `control` is resolved lazily on every request
 * so a control service that becomes available after webServer is picked up on
 * the next request; when it is never available, every v2 request returns 503.
 * The API wrapper is re-created whenever the control service identity changes
 * (an HMR reload of the control plugin provides a NEW service object), so a
 * request can never delegate to an unloaded provider.
 */
function makeV2Handler(resolveControl: () => ChannelControlLike | undefined) {
  let api: ChannelApiV2 | undefined;
  let apiControl: ChannelControlLike | undefined;

  // Re-create the API wrapper whenever the control service identity changes
  // (an HMR reload of the control plugin provides a NEW service object), so a
  // request can never delegate to an unloaded provider.
  function apiFor(control: ChannelControlLike): ChannelApiV2 {
    if (apiControl === control && api) return api;
    api = new ChannelApiV2(control);
    apiControl = control;
    return api;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/';
    const rawPath = url.split('?')[0] ?? '/';
    const pathname = rawPath.replace(/^\/dsh-channels\/api\/v2/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    // The control service is optional: without it every v2 route is 503 so the
    // standalone web profile still boots.
    const control = resolveControl();
    if (!control) {
      return sendJson(res, 503, errorBody('SERVICE_UNAVAILABLE', 'channel control is not available'));
    }
    const ready = apiFor(control);

    if (MUTATION_METHODS.has(method) && !isLoopbackAddress(req.socket.remoteAddress)) {
      return sendJson(res, 403, errorBody('FORBIDDEN', 'state-changing requests are loopback-only'));
    }

    if (isMutationWithBody(method)) {
      if (!isJsonContentType(req.headers['content-type'])) {
        return sendJson(res, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
      }
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body.ok) return sendJson(res, body.status, body.error);
      const result = await ready.handle(method, pathname, body.value);
      return sendJson(res, result.status, result.body);
    }

    if (method === 'GET' || method === 'DELETE') {
      const result = await ready.handle(method, pathname, undefined);
      return sendJson(res, result.status, result.body);
    }

    sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'method not allowed'));
  };
}

export function apply(ctx: Context): void {
  // v1 compat (doc §34): needs webServer + channels. The M1 auth start/poll/
  // input talk to ctx.channels adapters as today.
  ctx.inject(['webServer', 'channels'], (webCtx) => {
    const server = (webCtx as unknown as { webServer: WebServerLike }).webServer;
    const channels = (webCtx as unknown as { channels: ChannelsLike }).channels;
    const api = new ChannelApi(channels);

    return server.register({
      kind: 'prefix',
      path: '/dsh-channels/api/v1',
      handler: async (req, res) => {
        const url = req.url ?? '/';
        const rawPath = url.split('?')[0] ?? '/';
        const pathname = rawPath.replace(/^\/dsh-channels\/api\/v1/, '') || '/';
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'POST' && !isLoopbackAddress(req.socket.remoteAddress)) {
          return sendJson(res, 403, errorBody('FORBIDDEN', 'state-changing requests are loopback-only'));
        }
        if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
          return sendJson(res, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
        }
        if (method === 'POST') {
          const body = await readJsonBody<Record<string, unknown>>(req);
          if (!body.ok) return sendJson(res, body.status, body.error);
          const result = await api.handle(method, pathname, body.value);
          return sendJson(res, result.status, result.body);
        }
        if (method === 'GET') {
          const result = await api.handle(method, pathname, undefined);
          return sendJson(res, result.status, result.body);
        }
        sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'method not allowed'));
      },
    });
  });

  // v2 control-plane (doc §28–§33): needs webServer; channelControl is
  // optional — when absent, requests return 503. The control service is read
  // lazily via ctx.get() on every request (never cached in a module-level ref):
  // ctx.get() resolves only the currently active provider, so an HMR unload of
  // the control plugin immediately degrades to 503 instead of calling into an
  // already-unloaded service object.
  ctx.inject(['webServer'], (webCtx) => {
    const server = (webCtx as unknown as { webServer: WebServerLike }).webServer;
    return server.register({
      kind: 'prefix',
      path: '/dsh-channels/api/v2',
      handler: makeV2Handler(() => ctx.get('channelControl') as ChannelControlLike | undefined),
    });
  });
}

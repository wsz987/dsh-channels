/**
 * @wsz987/channel-web — host (Node) side.
 *
 * Cordis plugin entry for a Harness host process. Registers the
 * /dsh-channels/api/v1 webServer prefix route that powers the read-only
 * channels dashboard and the Weixin QR auth loop (M1).
 *
 * The webServer and channels services are injected dynamically via ctx.inject
 * so this plugin does not hard-depend on the web profile (it activates when a
 * webServer is present). The host entry exports ONLY name + apply — no
 * module-level inject export — which the bundle test asserts.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChannelApi, type ChannelsLike } from './host/routes.js';
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
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

export function apply(ctx: Context): void {
  // Wait for BOTH the webServer and channels services before wiring the API.
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

        // State-changing requests are loopback-only (403 otherwise).
        if (method === 'POST' && !isLoopbackAddress(req.socket.remoteAddress)) {
          return sendJson(res, 403, errorBody('FORBIDDEN', 'state-changing requests are loopback-only'));
        }

        // POST bodies must be application/json (415 otherwise).
        if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
          return sendJson(res, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
        }

        if (method === 'POST') {
          // Body size is capped at 64 KiB (413) by readJsonBody.
          const body = await readJsonBody<Record<string, unknown>>(req);
          if (!body.ok) {
            return sendJson(res, body.status, body.error);
          }
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
}

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import type { SyncWorker } from './worker.js';

const maxBodyBytes = 64 * 1024;
const seerrEvents = new Set(['MEDIA_PENDING', 'MEDIA_APPROVED', 'MEDIA_AUTO_APPROVED',
  'MEDIA_AUTO_REQUESTED', 'MEDIA_AVAILABLE', 'MEDIA_DECLINED', 'MEDIA_FAILED', 'TEST_NOTIFICATION']);
const jellyfinEvents = new Set(['ItemAdded', 'ItemDeleted', 'PlaybackStop', 'UserDataSaved']);

function authorized(req: IncomingMessage, secret: string): boolean {
  const headers: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'authorization') headers.push(req.rawHeaders[index + 1]);
  }
  if (headers.length !== 1 || !headers[0].startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(headers[0].slice(7)), digest(secret));
}

function readBody(req: IncomingMessage): Promise<{ status: 200; body: unknown } | { status: 400 | 413 }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    function finish(result: { status: 200; body: unknown } | { status: 400 | 413 }) {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
      resolve(result);
    }
    function onClose() {
      finish({ status: 400 });
    }
    function onData(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        req.pause();
        finish({ status: 413 });
      } else {
        chunks.push(chunk);
      }
    }
    function onEnd() {
      try {
        finish({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ status: 400 });
      }
    }
    req.once('close', onClose);
    req.once('end', onEnd);
    req.on('data', onData);
  });
}

export async function handleSyncWebhook(
  req: IncomingMessage, res: ServerResponse, config: AppConfig, worker: SyncWorker
): Promise<boolean> {
  const path = req.url?.split('?')[0];
  if (!path?.startsWith('/api/v1/sync/webhooks')) return false;
  const source = path === '/api/v1/sync/webhooks/seerr' ? 'seerr'
    : path === '/api/v1/sync/webhooks/jellyfin' ? 'jellyfin' : undefined;
  const secret = config.syncWebhookSecret;
  if (req.method !== 'POST' || !source || config.syncEnabled !== true || !secret) {
    sendError(res, 404, 'Not Found');
  } else if (!authorized(req, secret)) {
    res.setHeader('Connection', 'close');
    sendError(res, 401, 'Invalid authorization');
  } else if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    res.setHeader('Connection', 'close');
    sendError(res, 415, 'Expected application/json');
  } else {
    const result = await readBody(req);
    if (result.status === 413) {
      res.setHeader('Connection', 'close');
      sendError(res, 413, 'Request body too large');
    } else if (result.status === 400) {
      sendError(res, 400, 'Invalid JSON body');
    } else if (result.status === 200) {
      const body = result.body;
      const field = source === 'seerr' ? 'notification_type' : 'NotificationType';
      const event = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)[field] : undefined;
      const events = source === 'seerr' ? seerrEvents : jellyfinEvents;
      if (typeof event !== 'string' || !events.has(event)) {

        sendError(res, 400, 'Unsupported notification type');
      } else if (!worker.available(source) || (event !== 'TEST_NOTIFICATION' && !worker.accept(source))) {
        sendError(res, 503, 'Synchronization unavailable');
      } else {
        sendJson(res, 202, { status: 'accepted' });
      }
    }
  }
  return true;
}

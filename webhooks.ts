import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { enqueueComments, type CommentJob } from '../queue.js';

export const webhookRouter = Router();

// IMPORTANT: signatures are computed over the *raw* bytes, so no JSON parsing before verification.
webhookRouter.use(express.raw({ type: '*/*', limit: '1mb' }));

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && crypto.timingSafeEqual(a, b);

/* ───────────────────────────── META (FACEBOOK) ───────────────────────────── */

interface MetaFeedValue {
  item?: string;               // 'comment' | 'post' | 'status' | 'reaction' ...
  verb?: string;               // 'add' | 'edited' | 'remove' ...
  comment_id?: string;
  post_id?: string;
  parent_id?: string;          // equals post_id for top-level comments
  message?: string;
  created_time?: number;
  from?: { id: string; name?: string };
}
interface MetaWebhookBody {
  object: string;
  entry?: { id: string; time: number; changes?: { field: string; value: MetaFeedValue }[] }[];
}

function verifyMetaSignature(raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.meta.appSecret).update(raw).digest();
  let received: Buffer;
  try { received = Buffer.from(header.slice('sha256='.length), 'hex'); } catch { return false; }
  return safeEqual(received, expected);
}

/** Subscription handshake: Meta calls this once when you save the webhook in the App Dashboard. */
webhookRouter.get('/meta', (req: Request, res: Response) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
  if (mode === 'subscribe' && token === config.meta.verifyToken && challenge) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

webhookRouter.post('/meta', async (req: Request, res: Response) => {
  const raw = req.body as Buffer;
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);

  let body: MetaWebhookBody;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  if (body.object !== 'page') return res.sendStatus(200); // not ours; ack so Meta doesn't retry

  const jobs: CommentJob[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add') continue;
      if (!v.comment_id || !v.message) continue;               // e.g. photo-only comments
      if (v.from?.id === entry.id) continue;                   // ← our own Page's reply: prevents infinite reply loops
      jobs.push({
        platform: 'FACEBOOK',
        accountId: entry.id,
        commentId: v.comment_id,
        postId: v.post_id ?? '',
        parentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : undefined,
        authorId: v.from?.id,
        text: v.message,
        receivedAt: new Date((v.created_time ?? Date.now() / 1000) * 1000).toISOString(),
      });
    }
  }

  try {
    await enqueueComments(jobs);
    return res.sendStatus(200);          // ack fast: all heavy work happens in the worker
  } catch (err) {
    console.error('[meta-webhook] enqueue failed', err);
    return res.sendStatus(500);          // non-2xx → Meta retries delivery
  }
});

/* ──────────────────────────────── TIKTOK ─────────────────────────────────── */

interface TikTokWebhookBody {
  client_key: string;
  event: string;               // e.g. 'authorization.removed'
  create_time: number;
  user_openid: string;
  content: string;             // JSON-encoded string
}

/** Header format: `TikTok-Signature: t=<unix_ts>,s=<hex hmac_sha256(client_secret, "<t>.<raw_body>")>` */
function verifyTikTokSignature(raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.t || !parts.s || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;     // replay protection (5 min window)
  const expected = crypto.createHmac('sha256', config.tiktok.clientSecret).update(`${parts.t}.`).update(raw).digest();
  let received: Buffer;
  try { received = Buffer.from(parts.s, 'hex'); } catch { return false; }
  return safeEqual(received, expected);
}

webhookRouter.post('/tiktok', async (req: Request, res: Response) => {
  const raw = req.body as Buffer;
  if (!verifyTikTokSignature(raw, req.get('tiktok-signature'))) return res.sendStatus(401);

  let body: TikTokWebhookBody;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  if (body.client_key !== config.tiktok.clientKey) return res.sendStatus(200);

  let content: Record<string, any> = {};
  try { content = JSON.parse(body.content || '{}'); } catch { /* leave empty */ }

  try {
    switch (body.event) {
      case 'authorization.removed':
        // User revoked access in TikTok → stop using the stored tokens immediately.
        await prisma.socialAccount.updateMany({
          where: { platform: 'TIKTOK', accountId: body.user_openid },
          data: { status: 'REVOKED' },
        });
        break;

      // ⚠ ASSUMPTION — verify the event name and `content` shape against the webhook docs
      // for the TikTok product/scope your app is approved for. TikTok's public webhook
      // catalogue is narrower than Meta's; if no comment event is delivered to you, use the
      // polling fallback described in ARCHITECTURE.md (§6).
      case 'comment.create':
      case 'comment.publish': {
        const commentId = content.comment_id ?? content.id;
        const text = content.text ?? content.comment_text;
        const videoId = content.video_id ?? content.item_id;
        if (commentId && text && videoId && content.user_id !== body.user_openid) {
          await enqueueComments([{
            platform: 'TIKTOK',
            accountId: body.user_openid,
            commentId: String(commentId),
            postId: String(videoId),
            parentId: content.parent_comment_id ? String(content.parent_comment_id) : undefined,
            authorId: content.user_id ? String(content.user_id) : undefined,
            text: String(text),
            receivedAt: new Date((body.create_time ?? Date.now() / 1000) * 1000).toISOString(),
          }]);
        }
        break;
      }
      default:
        break; // unknown events are acknowledged and ignored
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('[tiktok-webhook] handling failed', err);
    return res.sendStatus(500);
  }
});

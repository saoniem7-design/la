import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { prisma } from './db.js';
import type { SocialAccount } from '@prisma/client';

/** Retryable: BullMQ pauses the whole queue for `retryAfterMs`, then retries the job. */
export class RateLimitError extends Error {
  constructor(public retryAfterMs: number, msg: string) { super(msg); }
}
/** Not retryable (bad token, permission removed, comment deleted...). */
export class PermanentError extends Error {}

/* ─────────────────────────────── Facebook ─────────────────────────────── */

// 4 = app limit, 17 = user limit, 32 = page limit, 613 = custom limit, 80001 = Pages API limit
const META_RATE_CODES = new Set([4, 17, 32, 613, 80001]);

export async function replyOnFacebook(commentId: string, pageToken: string, message: string) {
  const res = await fetch(`https://graph.facebook.com/${config.meta.graphVersion}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message, access_token: pageToken }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.ok && json.id) return json.id as string;

  const e = json.error ?? {};
  const msg = `Meta ${e.code ?? res.status}/${e.error_subcode ?? '-'}: ${e.message ?? res.statusText}`;
  if (META_RATE_CODES.has(e.code) || res.status === 429) {
    // Meta gives no Retry-After; start at 60s and let BullMQ's attempt count lengthen it.
    throw new RateLimitError(60_000, msg);
  }
  if (e.code === 190) throw new PermanentError(`Token invalid/expired — ${msg}`);   // mark account for re-auth
  if (e.code === 10 || e.code === 200 || e.code === 220) throw new PermanentError(`Permission — ${msg}`);
  if (e.code === 100 && e.error_subcode === 33) throw new PermanentError(`Comment gone — ${msg}`);
  throw new Error(msg);                                                              // transient → exponential retry
}

/* ─────────────────────────────── TikTok ─────────────────────────────── */

/**
 * ⚠ VERIFY: the reply endpoint below is the one specified in the brief. TikTok's comment
 * management lives under the TikTok API for Business / Accounts product and its availability,
 * scope names and path depend on which product your app is approved for. Confirm against the
 * docs inside your TikTok developer portal before launch; only this function should need to change.
 */
const TIKTOK_REPLY_URL = 'https://open.tiktokapis.com/v2/comment/reply/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

export async function replyOnTikTok(accessToken: string, videoId: string, commentId: string, text: string) {
  const res = await fetch(TIKTOK_REPLY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, comment_id: commentId, text }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.ok && (!json.error || json.error.code === 'ok')) return json?.data?.comment_id as string | undefined;

  const msg = `TikTok ${res.status}/${json?.error?.code ?? '-'}: ${json?.error?.message ?? res.statusText}`;
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new RateLimitError(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000, msg);
  }
  if (res.status === 401 || res.status === 403) throw new PermanentError(msg);
  throw new Error(msg);
}

/**
 * Refresh when <5 min remain. TikTok rotates refresh tokens, so concurrent refreshes would
 * invalidate each other — serialise per account with a Postgres advisory lock and re-read inside it.
 */
export async function getFreshTikTokToken(accountRowId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountRowId}, 0))`;
    const acct = await tx.socialAccount.findUniqueOrThrow({ where: { id: accountRowId } });
    const soon = Date.now() + 5 * 60_000;
    if (acct.accessTokenExpiresAt && acct.accessTokenExpiresAt.getTime() > soon) return decrypt(acct.accessTokenEncrypted);
    if (!acct.refreshTokenEncrypted) throw new PermanentError('No refresh token stored; user must reconnect TikTok');

    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: config.tiktok.clientKey,
        client_secret: config.tiktok.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: decrypt(acct.refreshTokenEncrypted),
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      await tx.socialAccount.update({ where: { id: acct.id }, data: { status: 'ERROR' } });
      throw new PermanentError(`TikTok refresh failed: ${j.error_description ?? j.error ?? res.status}`);
    }
    await tx.socialAccount.update({
      where: { id: acct.id },
      data: {
        accessTokenEncrypted: encrypt(j.access_token),
        refreshTokenEncrypted: encrypt(j.refresh_token ?? decrypt(acct.refreshTokenEncrypted)),
        accessTokenExpiresAt: new Date(Date.now() + j.expires_in * 1000),
        refreshTokenExpiresAt: j.refresh_expires_in ? new Date(Date.now() + j.refresh_expires_in * 1000) : acct.refreshTokenExpiresAt,
        status: 'ACTIVE',
      },
    });
    return j.access_token as string;
  });
}

export const maxReplyLength = (p: 'FACEBOOK' | 'TIKTOK') => (p === 'TIKTOK' ? 150 : 1000);
export type { SocialAccount };

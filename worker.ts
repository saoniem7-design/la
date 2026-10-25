import { Prisma } from '@prisma/client';
import { UnrecoverableError, Worker } from 'bullmq';
import { decrypt } from './crypto.js';
import { prisma } from './db.js';
import { connection, type CommentJob } from './queue.js';
import { getFreshTikTokToken, maxReplyLength, PermanentError, RateLimitError, replyOnFacebook, replyOnTikTok } from './platforms.js';
import { generateAiReply, pickFromPool, pickRule } from './rules.js';

async function handle(job: { data: CommentJob; attemptsMade: number }) {
  const { platform, accountId, commentId, postId, text, parentId } = job.data;

  // 1. Resolve the connected account
  const account = await prisma.socialAccount.findUnique({ where: { platform_accountId: { platform, accountId } } });

  // 2. Idempotent claim (DB unique index is the source of truth for dedupe)
  let log = await prisma.log.findUnique({ where: { platform_commentId: { platform, commentId } } });
  if (log && (log.status === 'REPLIED' || log.status === 'SKIPPED')) return;           // duplicate delivery
  if (!log) {
    try {
      log = await prisma.log.create({
        data: { platform, commentId, postId, userCommentText: text, socialAccountId: account?.id, status: 'PENDING' },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // lost the race to another worker
      throw e;
    }
  }
  const skip = (reason: string) => prisma.log.update({ where: { id: log!.id }, data: { status: 'SKIPPED', errorMessage: reason } });

  if (!account || account.status !== 'ACTIVE') return void (await skip('Account not connected or inactive'));
  if (parentId) return void (await skip('Nested reply; only top-level comments are auto-answered'));

  // 3. Rule selection
  const rules = await prisma.automationRule.findMany({
    where: {
      userId: account.userId, platform, status: 'ACTIVE',
      OR: [{ socialAccountId: account.id }, { socialAccountId: null }],
    },
    orderBy: { priority: 'asc' },
  });
  const rule = pickRule(rules, text);
  if (!rule) return void (await skip('No matching rule and no fallback'));

  // 4. Build the reply
  const limit = maxReplyLength(platform);
  const reply =
    rule.matchType === 'AI' && rule.aiPrompt
      ? await generateAiReply(rule.aiPrompt, text, limit)
      : pickFromPool(rule.replyTemplates)?.slice(0, limit);
  if (!reply) return void (await skip('Rule produced no reply'));

  await prisma.log.update({ where: { id: log.id }, data: { ruleId: rule.id, replyText: reply, attempts: { increment: 1 } } });

  // 5. Post it
  try {
    if (platform === 'FACEBOOK') {
      await replyOnFacebook(commentId, decrypt(account.accessTokenEncrypted), reply);
    } else {
      const token = await getFreshTikTokToken(account.id);
      await replyOnTikTok(token, postId, commentId, reply);
    }
    await prisma.log.update({ where: { id: log.id }, data: { status: 'REPLIED', repliedAt: new Date(), errorMessage: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitError) {
      await worker.rateLimit(err.retryAfterMs);         // pauses *all* jobs on this worker, not just this one
      throw Worker.RateLimitError();
    }
    if (err instanceof PermanentError) {
      await prisma.log.update({ where: { id: log.id }, data: { status: 'FAILED', errorMessage: message } });
      if (/Token invalid|refresh failed/i.test(message)) {
        await prisma.socialAccount.update({ where: { id: account.id }, data: { status: 'ERROR' } });
      }
      throw new UnrecoverableError(message);
    }
    await prisma.log.update({ where: { id: log.id }, data: { errorMessage: message } });
    throw err;                                          // exponential backoff via queue defaults
  }
}

const worker = new Worker<CommentJob>(
  'comment-replies',
  async (job) => {
    const lockKey = `lock:${job.data.platform}:${job.data.commentId}`;
    if (!(await connection.set(lockKey, '1', 'EX', 120, 'NX'))) return; // same comment already in flight
    try { await handle(job); } finally { await connection.del(lockKey); }
  },
  {
    connection,
    concurrency: 5,
    limiter: { max: 30, duration: 60_000 },            // soft global ceiling; tune per-platform quotas
  },
);

worker.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await prisma.log.updateMany({
      where: { platform: job.data.platform, commentId: job.data.commentId, status: { not: 'REPLIED' } },
      data: { status: 'FAILED', errorMessage: err.message },
    });
  }
});

process.on('SIGTERM', async () => { await worker.close(); process.exit(0); });
console.log('reply worker started');

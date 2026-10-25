import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export type PlatformName = 'FACEBOOK' | 'TIKTOK';

export interface CommentJob {
  platform: PlatformName;
  accountId: string;      // FB Page ID / TikTok open_id
  commentId: string;
  postId: string;         // FB post id / TikTok video id
  parentId?: string;      // set when the comment is itself a reply
  authorId?: string;
  text: string;
  receivedAt: string;
}

export const commentQueue = new Queue<CommentJob>('comment-replies', {
  connection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 2_000 }, // 2s, 4s, 8s, 16s, 32s
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

const jitterMs = () => {
  const { replyDelayMinS: lo, replyDelayMaxS: hi } = config;
  if (hi <= 0) return 0;
  return Math.round((lo + Math.random() * Math.max(0, hi - lo)) * 1000);
};

/** Enqueue with a deterministic jobId so redelivered webhooks collapse into one job. */
export async function enqueueComments(jobs: CommentJob[]) {
  if (!jobs.length) return;
  await commentQueue.addBulk(
    jobs.map((data) => ({
      name: 'reply',
      data,
      opts: { jobId: `${data.platform}_${data.commentId}`, delay: jitterMs() },
    })),
  );
}

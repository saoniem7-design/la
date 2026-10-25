import 'dotenv/config';

const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};

const encKey = Buffer.from(req('TOKEN_ENC_KEY'), 'base64');
if (encKey.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (base64) for AES-256');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: req('REDIS_URL'),
  tokenEncKey: encKey,
  tokenEncKeyVersion: process.env.TOKEN_ENC_KEY_VERSION ?? '1',
  meta: {
    appSecret: req('META_APP_SECRET'),
    verifyToken: req('META_VERIFY_TOKEN'),
    graphVersion: process.env.META_GRAPH_VERSION ?? 'v23.0',
  },
  tiktok: {
    clientKey: req('TIKTOK_CLIENT_KEY'),
    clientSecret: req('TIKTOK_CLIENT_SECRET'),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  },
  replyDelayMinS: Number(process.env.REPLY_DELAY_MIN_S ?? 5),
  replyDelayMaxS: Number(process.env.REPLY_DELAY_MAX_S ?? 30),
} as const;

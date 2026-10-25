-- 0001_init: users, social_accounts, automation_rules, logs
-- Requires PostgreSQL 13+ (gen_random_uuid() built in).

CREATE TYPE "Platform"      AS ENUM ('FACEBOOK', 'TIKTOK');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');
CREATE TYPE "MatchType"     AS ENUM ('EXACT', 'CONTAINS', 'REGEX', 'AI', 'FALLBACK');
CREATE TYPE "RuleStatus"    AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "LogStatus"     AS ENUM ('PENDING', 'REPLIED', 'SKIPPED', 'FAILED');

CREATE TABLE "users" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "email"         TEXT           NOT NULL,
  "password_hash" TEXT           NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "social_accounts" (
  "id"                        UUID            NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                   UUID            NOT NULL,
  "platform"                  "Platform"      NOT NULL,
  "account_id"                TEXT            NOT NULL,
  "account_name"              TEXT,
  "access_token_encrypted"    TEXT            NOT NULL,
  "refresh_token_encrypted"   TEXT,
  "access_token_expires_at"   TIMESTAMPTZ(6),
  "refresh_token_expires_at"  TIMESTAMPTZ(6),
  "scopes"                    TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"                    "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "webhook_subscribed"        BOOLEAN         NOT NULL DEFAULT false,
  "created_at"                TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "social_accounts_platform_account_id_key" ON "social_accounts"("platform", "account_id");
CREATE INDEX "social_accounts_user_id_idx" ON "social_accounts"("user_id");
CREATE INDEX "social_accounts_access_token_expires_at_idx" ON "social_accounts"("access_token_expires_at");

CREATE TABLE "automation_rules" (
  "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
  "user_id"           UUID           NOT NULL,
  "social_account_id" UUID,
  "platform"          "Platform"     NOT NULL,
  "name"              TEXT           NOT NULL,
  "match_type"        "MatchType"    NOT NULL,
  "trigger_keywords"  TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "case_sensitive"    BOOLEAN        NOT NULL DEFAULT false,
  "reply_template"    TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ai_prompt"         TEXT,
  "priority"          INTEGER        NOT NULL DEFAULT 100,
  "status"            "RuleStatus"   NOT NULL DEFAULT 'ACTIVE',
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "automation_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "automation_rules_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A rule must be able to produce a reply
  CONSTRAINT "automation_rules_has_reply_source" CHECK (
    cardinality("reply_template") > 0 OR ("match_type" = 'AI' AND "ai_prompt" IS NOT NULL)
  )
);
CREATE INDEX "automation_rules_lookup_idx" ON "automation_rules"("user_id", "platform", "status", "priority");

CREATE TABLE "logs" (
  "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
  "platform"          "Platform"     NOT NULL,
  "comment_id"        TEXT           NOT NULL,
  "post_id"           TEXT,
  "social_account_id" UUID,
  "rule_id"           UUID,
  "user_comment_text" TEXT           NOT NULL,
  "reply_text"        TEXT,
  "status"            "LogStatus"    NOT NULL DEFAULT 'PENDING',
  "error_message"     TEXT,
  "attempts"          INTEGER        NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "replied_at"        TIMESTAMPTZ(6),
  CONSTRAINT "logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "logs_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "logs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Dedupe guarantee: one row per platform comment, ever.
CREATE UNIQUE INDEX "logs_platform_comment_id_key" ON "logs"("platform", "comment_id");
CREATE INDEX "logs_social_account_id_created_at_idx" ON "logs"("social_account_id", "created_at");
CREATE INDEX "logs_status_created_at_idx" ON "logs"("status", "created_at");

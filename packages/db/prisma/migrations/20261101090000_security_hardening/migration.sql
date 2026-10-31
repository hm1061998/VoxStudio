-- AlterTable
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMPTZ(3),
ADD COLUMN "password_changed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "audit_events" ALTER COLUMN "workspace_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "auth_throttles" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_failure_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "auth_throttles_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "auth_throttles_last_failure_at_idx" ON "auth_throttles"("last_failure_at");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at" DESC);

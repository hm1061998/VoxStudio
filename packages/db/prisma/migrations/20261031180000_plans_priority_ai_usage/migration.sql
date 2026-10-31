-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'free';

-- AlterTable
ALTER TABLE "render_jobs" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "engine_id" TEXT NOT NULL,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "audio_ms" INTEGER NOT NULL DEFAULT 0,
    "segments" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_workspace_id_month_engine_id_key" ON "ai_usage"("workspace_id", "month", "engine_id");

-- CreateIndex
CREATE INDEX "render_jobs_status_priority_created_at_idx" ON "render_jobs"("status", "priority", "created_at");

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

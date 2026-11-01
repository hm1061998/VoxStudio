-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "plan_expires_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "amount_vnd" INTEGER NOT NULL,
    "payment_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paid_via" TEXT,
    "paid_amount_vnd" INTEGER,
    "paid_at" TIMESTAMPTZ(3),
    "confirmed_by_user_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount_vnd" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "order_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_payment_code_key" ON "orders"("payment_code");

-- CreateIndex
CREATE INDEX "orders_workspace_id_created_at_idx" ON "orders"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "payment_events_result_created_at_idx" ON "payment_events"("result", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

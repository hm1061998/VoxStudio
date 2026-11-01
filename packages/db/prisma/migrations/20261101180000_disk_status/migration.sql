-- CreateTable
CREATE TABLE "disk_status" (
    "id" INTEGER NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "free_bytes" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disk_status_pkey" PRIMARY KEY ("id")
);

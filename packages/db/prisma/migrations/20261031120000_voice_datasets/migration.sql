-- CreateTable
CREATE TABLE "tts_voice_datasets" (
    "id" UUID NOT NULL,
    "voice_id" TEXT NOT NULL,
    "dataset_version" TEXT NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "units_sha256" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "report_json" JSONB NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tts_voice_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tts_voice_datasets_voice_id_manifest_sha256_key" ON "tts_voice_datasets"("voice_id", "manifest_sha256");

-- CreateIndex
CREATE INDEX "tts_voice_datasets_voice_id_recorded_at_idx" ON "tts_voice_datasets"("voice_id", "recorded_at" DESC);

-- AddForeignKey
ALTER TABLE "tts_voice_datasets" ADD CONSTRAINT "tts_voice_datasets_voice_id_fkey" FOREIGN KEY ("voice_id") REFERENCES "tts_voices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

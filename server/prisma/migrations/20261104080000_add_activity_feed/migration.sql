-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('SHIFT_CREATED', 'SHIFT_UPDATED', 'SHIFT_CANCELLED', 'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED', 'SWAP_REQUESTED', 'SWAP_PEER_ACCEPTED', 'SWAP_PEER_DECLINED', 'SWAP_APPROVED', 'SWAP_REJECTED', 'SWAP_CANCELLED');

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "ActivityEventType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityEvent_teamId_createdAt_id_idx" ON "ActivityEvent"("teamId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ActivityEvent_actorUserId_idx" ON "ActivityEvent"("actorUserId");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

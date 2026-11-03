-- CreateEnum
CREATE TYPE "ShiftSwapStatus" AS ENUM ('PENDING_PEER', 'PENDING_MANAGER', 'APPROVED', 'REJECTED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ShiftSwapRequest" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "sourceShiftId" TEXT NOT NULL,
    "targetShiftId" TEXT NOT NULL,
    "requestingUserId" TEXT NOT NULL,
    "receivingUserId" TEXT NOT NULL,
    "sourceShiftUpdatedAt" TIMESTAMP(3) NOT NULL,
    "targetShiftUpdatedAt" TIMESTAMP(3) NOT NULL,
    "status" "ShiftSwapStatus" NOT NULL DEFAULT 'PENDING_PEER',
    "peerRespondedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_teamId_status_idx" ON "ShiftSwapRequest"("teamId", "status");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_requestingUserId_status_idx" ON "ShiftSwapRequest"("requestingUserId", "status");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_receivingUserId_status_idx" ON "ShiftSwapRequest"("receivingUserId", "status");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_sourceShiftId_idx" ON "ShiftSwapRequest"("sourceShiftId");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_targetShiftId_idx" ON "ShiftSwapRequest"("targetShiftId");

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_sourceShiftId_fkey" FOREIGN KEY ("sourceShiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_targetShiftId_fkey" FOREIGN KEY ("targetShiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_requestingUserId_fkey" FOREIGN KEY ("requestingUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_receivingUserId_fkey" FOREIGN KEY ("receivingUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


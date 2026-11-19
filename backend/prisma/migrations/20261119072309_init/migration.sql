-- CreateEnum
CREATE TYPE "PunchType" AS ENUM ('IN', 'BREAK_START', 'BREAK_END', 'OUT');

-- CreateEnum
CREATE TYPE "PunchSource" AS ENUM ('BIOMETRIC', 'WEB_PORTAL', 'HR_MANUAL');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('SICK', 'CASUAL', 'EARNED');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PolicyCategory" AS ENUM ('PUNCH', 'OVERTIME', 'BREAK', 'REST_GAP', 'LEAVE', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'PROPOSED', 'APPROVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AuditDecision" AS ENUM ('APPROVED', 'EDITED_AND_APPROVED', 'ESCALATED');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "empCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "hourlyRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "expectedMinutes" INTEGER NOT NULL,
    "isWeeklyOff" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PunchLog" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "punchType" "PunchType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "source" "PunchSource" NOT NULL,

    CONSTRAINT "PunchLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyRule" (
    "id" TEXT NOT NULL,
    "policyCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "PolicyCategory" NOT NULL,
    "region" TEXT NOT NULL,
    "ruleText" TEXT NOT NULL,
    "thresholdJson" JSONB NOT NULL,
    "qdrantPointId" TEXT,

    CONSTRAINT "PolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimecardException" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "anomalyCode" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "status" "ExceptionStatus" NOT NULL,
    "deterministicDetailsJson" JSONB NOT NULL,
    "aiProposalJson" JSONB,
    "guardrailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimecardException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "exceptionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "actionBy" TEXT NOT NULL,
    "decision" "AuditDecision" NOT NULL,
    "beforePunchesJson" JSONB NOT NULL,
    "afterPunchesJson" JSONB NOT NULL,
    "citedPolicyCode" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_empCode_key" ON "Employee"("empCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_email_key" ON "Employee"("email");

-- CreateIndex
CREATE INDEX "Employee_region_idx" ON "Employee"("region");

-- CreateIndex
CREATE INDEX "Employee_department_idx" ON "Employee"("department");

-- CreateIndex
CREATE INDEX "Shift_date_idx" ON "Shift"("date");

-- CreateIndex
CREATE INDEX "Shift_employeeId_date_idx" ON "Shift"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_employeeId_date_key" ON "Shift"("employeeId", "date");

-- CreateIndex
CREATE INDEX "PunchLog_employeeId_date_idx" ON "PunchLog"("employeeId", "date");

-- CreateIndex
CREATE INDEX "PunchLog_timestamp_idx" ON "PunchLog"("timestamp");

-- CreateIndex
CREATE INDEX "LeaveRequest_employeeId_startDate_endDate_idx" ON "LeaveRequest"("employeeId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyRule_policyCode_key" ON "PolicyRule"("policyCode");

-- CreateIndex
CREATE INDEX "PolicyRule_category_idx" ON "PolicyRule"("category");

-- CreateIndex
CREATE INDEX "PolicyRule_region_idx" ON "PolicyRule"("region");

-- CreateIndex
CREATE INDEX "TimecardException_employeeId_date_idx" ON "TimecardException"("employeeId", "date");

-- CreateIndex
CREATE INDEX "TimecardException_status_idx" ON "TimecardException"("status");

-- CreateIndex
CREATE INDEX "TimecardException_anomalyCode_idx" ON "TimecardException"("anomalyCode");

-- CreateIndex
CREATE INDEX "AuditLog_exceptionId_idx" ON "AuditLog"("exceptionId");

-- CreateIndex
CREATE INDEX "AuditLog_employeeId_idx" ON "AuditLog"("employeeId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLog" ADD CONSTRAINT "PunchLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimecardException" ADD CONSTRAINT "TimecardException_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "TimecardException"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runFullTimecardScan } from "../services/scannerService";

const prisma = new PrismaClient();

runFullTimecardScan()
  .then(async (result) => {
    console.log(`Timecard scan complete: ${result.scanned} employee-date combinations, ${result.createdOrUpdated} open exception records created or updated.`);
  })
  .catch((error) => {
    console.error("Timecard scan failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { PrismaClient, LeaveStatus, PolicyCategory, PunchSource, PunchType } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

const employees = [
  ["EMP001", "Aarav Shah", "aarav.shah@example.com", "Engineer", "Engineering", "IN", 42, "Platform Engineering", "12 MG Road, Bengaluru", "+91-9876543210"],
  ["EMP002", "Priya Nair", "priya.nair@example.com", "Platform Engineer", "Engineering", "IN", 45, "Cloud Platform", "44 Marine Drive, Mumbai", "+91-9876543211"],
  ["EMP003", "Vikram Rao", "vikram.rao@example.com", "QA Analyst", "Engineering", "IN", 38, "Quality Engineering", "8 Whitefield, Bengaluru", "+91-9876543212"],
  ["EMP004", "Ananya Das", "ananya.das@example.com", "Security Analyst", "Engineering", "IN", 44, "Security Engineering", "21 Salt Lake, Kolkata", "+91-9876543213"],
  ["EMP005", "Rohan Mehta", "rohan.mehta@example.com", "DevOps Engineer", "Engineering", "US", 58, "Infrastructure", "220 Broadway, New York", "+1-212-555-0105"],
  ["EMP006", "Mia Johnson", "mia.johnson@example.com", "Software Engineer", "Engineering", "US", 62, "Product Engineering", "98 Market St, San Francisco", "+1-415-555-0106"],
  ["EMP007", "Liam Chen", "liam.chen@example.com", "Warehouse Associate", "Warehouse Ops", "US", 24, "Inbound Operations", "310 King Ave, Austin", "+1-512-555-0107"],
  ["EMP008", "Noah Williams", "noah.williams@example.com", "Forklift Operator", "Warehouse Ops", "US", 27, "Fulfillment", "77 Pine Ave, Dallas", "+1-214-555-0108"],
  ["EMP009", "Saanvi Iyer", "saanvi.iyer@example.com", "Inventory Coordinator", "Warehouse Ops", "IN", 23, "Inventory Control", "5 Anna Nagar, Chennai", "+91-9876543218"],
  ["EMP010", "Kabir Kapoor", "kabir.kapoor@example.com", "Dispatch Associate", "Warehouse Ops", "IN", 22, "Dispatch Operations", "18 Sector 17, Chandigarh", "+91-9876543219"],
  ["EMP011", "Ishaan Bose", "ishaan.bose@example.com", "Packing Lead", "Warehouse Ops", "IN", 25, "Packing Operations", "33 Park Street, Kolkata", "+91-9876543220"],
  ["EMP012", "Emma Davis", "emma.davis@example.com", "Customer Support Specialist", "Customer Support", "US", 26, "Tier 1 Support", "41 State St, Boston", "+1-617-555-0112"],
  ["EMP013", "Olivia Brown", "olivia.brown@example.com", "Support Team Lead", "Customer Support", "US", 32, "Support Operations", "640 Madison Ave, New York", "+1-212-555-0113"],
  ["EMP014", "Ethan Wilson", "ethan.wilson@example.com", "Support Specialist", "Customer Support", "US", 28, "Technical Support", "155 Peachtree St, Atlanta", "+1-404-555-0114"],
  ["EMP015", "Meera Kulkarni", "meera.kulkarni@example.com", "Support Specialist", "Customer Support", "IN", 23, "Customer Care", "9 FC Road, Pune", "+91-9876543224"],
  ["EMP016", "Aditya Singh", "aditya.singh@example.com", "Support Analyst", "Customer Support", "IN", 23, "Helpdesk", "27 Gomti Nagar, Lucknow", "+91-9876543225"],
  ["EMP017", "Sophia Martinez", "sophia.martinez@example.com", "Accountant", "Finance", "US", 36, "Accounting", "95 Loop St, Chicago", "+1-312-555-0117"],
  ["EMP018", "James Miller", "james.miller@example.com", "Payroll Analyst", "Finance", "US", 39, "Payroll Operations", "12 Congress Ave, Austin", "+1-512-555-0118"],
  ["EMP019", "Neha Gupta", "neha.gupta@example.com", "Financial Analyst", "Finance", "IN", 34, "FP&A", "4 DLF Phase 3, Gurgaon", "+91-9876543228"],
  ["EMP020", "Arjun Malhotra", "arjun.malhotra@example.com", "Accounts Coordinator", "Finance", "IN", 31, "Accounts Payable", "62 Banjara Hills, Hyderabad", "+91-9876543229"],
] as const;

const policyRules: Array<{
  policyCode: string;
  title: string;
  category: PolicyCategory;
  region: "ALL" | "IN" | "US";
  ruleText: string;
  thresholdJson: object;
}> = [
  { policyCode: "POL-PUNCH-01", title: "Missed Clock-Out Verification", category: "PUNCH", region: "ALL", ruleText: "An employee shift must contain a final OUT punch. A missing clock-out requires HR verification or an approved correction.", thresholdJson: { missingOut: true } },
  { policyCode: "POL-PUNCH-02", title: "Open or Unclosed Break Punch", category: "BREAK", region: "ALL", ruleText: "Every BREAK_START punch must be paired with a BREAK_END punch on the same date before payroll review.", thresholdJson: { pairedBreakRequired: true } },
  { policyCode: "POL-OT-01", title: "Daily Overtime Approval", category: "OVERTIME", region: "ALL", ruleText: "Work exceeding 9 hours in a single day requires a policy-compliant overtime approval before payroll.", thresholdJson: { dailyHours: 9 } },
  { policyCode: "POL-OT-02", title: "Weekly Overtime Threshold", category: "OVERTIME", region: "ALL", ruleText: "Total scheduled and worked time exceeding 40 hours in a work week requires a review and approval.", thresholdJson: { weeklyHours: 40 } },
  { policyCode: "POL-BRK-01", title: "Mandatory Meal Break", category: "BREAK", region: "ALL", ruleText: "An uninterrupted work period of more than 5 hours requires a meal break of at least 30 minutes.", thresholdJson: { continuousHoursBeforeBreak: 5, minimumBreakMinutes: 30 } },
  { policyCode: "POL-RST-01", title: "Minimum Rest Gap", category: "REST_GAP", region: "ALL", ruleText: "Consecutive shifts must have at least 11 hours of rest between the end of one shift and the start of the next.", thresholdJson: { minimumRestHours: 11 } },
  { policyCode: "POL-LV-01", title: "Approved Leave Punch Conflict", category: "LEAVE", region: "ALL", ruleText: "No work punches should be recorded on an approved leave date unless the leave is modified or rejected.", thresholdJson: { approvedLeaveConflict: true } },
  { policyCode: "POL-SCH-01", title: "Scheduled Shift Variance", category: "SCHEDULE", region: "ALL", ruleText: "A punch variance greater than 2 hours outside the scheduled shift start or end requires manager verification.", thresholdJson: { varianceHours: 2 } },
];

function isoAt(date: string, hour: number, minute = 0): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

async function main() {
  await prisma.auditLog.deleteMany();
  await prisma.timecardException.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.punchLog.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.policyRule.deleteMany();
  await prisma.employee.deleteMany();

  await prisma.policyRule.createMany({ data: policyRules });
  const createdEmployees = [];
  for (let index = 0; index < employees.length; index++) {
    const [empCode, name, email, role, department, region, hourlyRate, team, address, phone] = employees[index];
    createdEmployees.push(await prisma.employee.create({
      data: {
        empCode,
        name,
        email,
        role,
        department,
        region,
        hourlyRate,
        team,
        address,
        phone,
        isRegistered: index < 2,
        passwordHash: index < 2 ? hashPassword("Pass@123") : null,
        status: index < 2 ? "ACTIVATED" : "PENDING_REGISTRATION",
      },
    }));
  }

  const anomalyPattern = [
    ["PUNCH", "POL-PUNCH-01", "HIGH"],
    ["BREAK", "POL-PUNCH-02", "MEDIUM"],
    ["OVERTIME_DAILY", "POL-OT-01", "HIGH"],
    ["OVERTIME_WEEKLY", "POL-OT-02", "HIGH"],
    ["BREAK", "POL-BRK-01", "MEDIUM"],
    ["REST_GAP", "POL-RST-01", "HIGH"],
    ["LEAVE_CONFLICT", "POL-LV-01", "MEDIUM"],
    ["SCHEDULE_VARIANCE", "POL-SCH-01", "MEDIUM"],
  ] as const;

  let timecardIndex = 0;
  let anomalyIndex = 0;
  for (let employeeIndex = 0; employeeIndex < createdEmployees.length; employeeIndex++) {
    const employee = createdEmployees[employeeIndex];
    const timecardCount = employeeIndex < 5 ? 3 : 2;
    for (let dayOffset = 0; dayOffset < timecardCount; dayOffset++) {
      const date = new Date(Date.UTC(2026, 10, 13 - dayOffset));
      const dateString = date.toISOString().slice(0, 10);
      const startHour = 9;
      const endHour = 17 + (employeeIndex % 3);
      const scheduledStart = isoAt(dateString, startHour);
      const scheduledEnd = isoAt(dateString, endHour);
      timecardIndex++;
      await prisma.shift.create({
        data: { employeeId: employee.id, date: dateString, scheduledStart, scheduledEnd, expectedMinutes: (endHour - startHour) * 60, isWeeklyOff: dayOffset === 6 },
      });
      const clean = timecardIndex > 18;
      let punches: Array<{ punchType: PunchType; hour: number; minute: number; source: PunchSource }> = [
        { punchType: "IN", hour: 9, minute: 0, source: "BIOMETRIC" },
        { punchType: "BREAK_START", hour: 13, minute: 0, source: "BIOMETRIC" },
        { punchType: "BREAK_END", hour: 13, minute: 30, source: "BIOMETRIC" },
        { punchType: "OUT", hour: endHour, minute: 0, source: "BIOMETRIC" },
      ];

      if (!clean) {
        const [category, policyCode, severity] = anomalyPattern[anomalyIndex % anomalyPattern.length];
        anomalyIndex++;

        if (category === "PUNCH") punches = punches.filter((p) => p.punchType !== "OUT");
        if (category === "BREAK") punches = punches.filter((p) => p.punchType !== "BREAK_END");
        if (category === "OVERTIME_DAILY") punches[3].hour = 19;
        if (category === "OVERTIME_WEEKLY") punches[3].hour = 18;
        if (category === "BREAK" && policyCode === "POL-BRK-01") punches = punches.filter((p) => p.punchType !== "BREAK_START" && p.punchType !== "BREAK_END");
        if (category === "REST_GAP") punches[0].hour = 7;
        if (category === "SCHEDULE_VARIANCE") punches[0].hour = 5;
        if (category === "LEAVE_CONFLICT") {
          await prisma.leaveRequest.create({
            data: { employeeId: employee.id, startDate: dateString, endDate: dateString, leaveType: "CASUAL", reason: "Pre-approved personal leave", status: LeaveStatus.APPROVED },
          });
        }

        await prisma.timecardException.create({
          data: {
            employeeId: employee.id,
            date: dateString,
            anomalyCode: policyCode,
            severity: severity === "HIGH" ? "HIGH" : "MEDIUM",
            status: "OPEN",
            deterministicDetailsJson: {
              category,
              policyCode,
              detectedFromSeedData: true,
              description: `Seeded realistic ${category.toLowerCase().replaceAll("_", " ")} anomaly`,
            },
          },
        });
      }

      for (const punch of punches) {
        await prisma.punchLog.create({
          data: {
            employeeId: employee.id,
            date: dateString,
            punchType: punch.punchType,
            timestamp: isoAt(dateString, punch.hour, punch.minute),
            source: punch.source,
          },
        });
      }
    }
  }

  console.log(`Seeded ${createdEmployees.length} employees, ${policyRules.length} policy rules, shifts, punch logs, leave requests, and realistic timecard exceptions.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });











  
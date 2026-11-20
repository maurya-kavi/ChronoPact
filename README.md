# ChronoPact

**ChronoPact** is a governed **Time and Attendance Exception Resolution Agent** built for **Dayforce Use Case 5**. It detects workforce timecard anomalies prior to payroll cutoff, retrieves relevant labor and company policy clauses via Qdrant RAG, proposes policy-compliant corrections using open-weight LLMs, verifies proposals through a deterministic post-fix simulation gate, and enforces explicit human approval before mutating timecards or writing immutable audit records.

## Project Deliverables & Quick Links

| Deliverable | Link |
| :--- | :--- |
| **5-Slide Final Presentation (PPT)** | [View Presentation](https://docs.google.com/presentation/d/1ccd8FW0foo9EvYwU7c1tyYXpVSu0jpXk/edit?usp=drive_link&ouid=116701994795863449755&rtpof=true&sd=true) |
| **10-Minute End-to-End Demo Video** | [Watch Demo Recording](https://nitjsr-my.sharepoint.com/:v:/g/personal/2023ugee041_nitjsr_onmicrosoft_com/IQBLExKeGzaLTZbtzF4Xdi9GAYVD9Ig5qTF9ljbf_bvslaw?e=fcb4sd) |
| **Author Resume / CV (Kavindra Kumar)** | [View Resume](https://drive.google.com/file/d/1CO51djNVW2X6BkyoxZqRvd3QdZoc_i0u/view?usp=sharing) |

---

## Problem Statement

Before every payroll run, HR and payroll operations teams must manually triage missed clock-outs, unclosed meal breaks, shift window mismatches, unapproved daily overtime, rest-gap violations, and punches logged during approved leaves. Conversely, allowing an unguarded LLM to directly edit payroll data risks hallucinated timestamps and compliance violations.

ChronoPact solves this through a **hybrid neuro-symbolic architecture**:
1. **Deterministic TypeScript Rule Engine** detects anomalies and validates post-fix schedules using exact time arithmetic—zero AI guesswork.
2. **Open-Weight Reasoning Models (`openai/gpt-oss-120b` / `openai/gpt-oss-20b`)** explain root causes, cite retrieved policy clauses, and propose structured corrections.
3. **Strict RBAC & Human-in-the-Loop Governance** ensure employees control their own live punches and leave requests, while HR Admins retain sole approval authority over exception resolutions and audit logs.

---

## Key Features

### 1. Role-Based Access Control (RBAC) & Governance
- **HR-First Employee Provisioning:** HR Admins onboard employees in the directory before employees can self-register (`isRegistered` verification).
- **Strict Separation of Duties:** HR Admins are blocked at both the UI and API levels (`403 Forbidden`) from clocking in/out or submitting leave requests on behalf of employees.
- **IST (`Asia/Kolkata`, `UTC+05:30`) Standardization:** All punch timestamps, Before/After diff inputs, leave validations, and audit trails are standardized to Indian Standard Time.

### 2. Employee Self-Service Portal
- **Current-Date Locked Punch Pad:** Employees can log `CLOCK_IN`, `BREAK_START`, `BREAK_END`, and `CLOCK_OUT` exclusively for the current IST calendar date (preventing backdated punches).
- **Leave Application & Conflict Guard:** Employees can submit leave requests for today or future IST dates (past dates are blocked on both frontend pickers and backend APIs). Approved leaves automatically block punch logging on overlapping dates.
- **Monthly Attendance Compliance Report:** Read-only employee profile alongside daily attendance summaries tracking present days, leaves, missing punches, overtime, and undertime.

### 3. HR Admin Operations Console (5 Integrated Modules)
1. **Exception Queue:** Filterable by date, month, and status (`Active / Unresolved`, `Open`, `Proposed`, `Escalated`). Includes a side-by-side **Before vs. After (IST)** resolution drawer, multi-anomaly auto-healing, `Guardrail Verified Safe` simulation badges, and actions to **Approve Proposal**, **Save Edited Time and Approve**, or **Escalate to Senior HR**. Resolved items automatically clear from active queues and show green `Resolved` badges in Employee 360°.
2. **Employee Directory & Employee 360°:** Onboard new employees, update shift windows, departments, teams, and regions, and inspect daily attendance and resolved exceptions per employee.
3. **Policy Knowledge Base:** Upload multi-page **PDF, DOCX, CSV, TXT, and MD** policy documents. An asynchronous background ingestion worker tracks progress live (`Queued → Extracting → Chunking → Embedding → Done`) and extracts editable `POL-*` rules.
4. **Immutable Audit Log & CSV Export:** Tamper-evident compliance ledger recording Before/After IST punches, cited policy codes, reviewer names, notes, and one-click **CSV Export** for payroll audits.
5. **Chat (Qdrant-Grounded HR Policy Assistant):** Conversational RAG assistant (`POST /api/policies/chat`) grounded strictly in uploaded PDF, CSV, and DOCX policy chunks indexed in Qdrant—complete with document-scope filtering, anti-hallucination constraints, and expandable source citations (document filename, policy code, relevance score, and snippet).

---

## Model and License Compliance

| Component | Model / Technology | License | Deployment |
|---|---|---|---|
| **Primary Reasoning LLM** | `openai/gpt-oss-120b` | Apache 2.0 | Groq OpenAI-compatible inference API |
| **Fallback & Eval LLM** | `openai/gpt-oss-20b` | Apache 2.0 | Groq OpenAI-compatible inference API (auto-fallback on HTTP 429) |
| **Local Embeddings** | `Xenova/all-MiniLM-L6-v2` | Apache 2.0 | 384-dimension local embeddings via Transformers.js |
| **Document Parser** | IBM Docling | MIT | Python FastAPI sidecar (`docling-service`) |

> Groq is used strictly as an OpenAI-compatible inference provider. Set `LLM_BASE_URL` to a local Ollama endpoint (`http://localhost:11434/v1`) for fully air-gapped execution.

---

## Architecture

```text
+--------------------------+       +---------------------------------------+
| React / Vite / Tailwind  | ----> | Express / TypeScript API              |
| - Employee Portal (IST)  |       | - JWT + Strict RBAC Middleware        |
| - HR 5-Tab Console:      |       | - Zod Validation, OpenAPI, Prisma ORM |
|   Queue | Directory |    |       +----------+----------------+-----------+
|   Policies | Audit | Chat|                  |                |
+------------+-------------+                  |                |
             |                        +-------v------+   +-----v---------------+
             |                        | Deterministic|   | Qdrant Vector Store |
             v                        | Rule Engine  |   | - Policy Chunks     |
+--------------------------+          | & Post-Fix   |   | - Metadata Filters  |
| IBM Docling Sidecar      | -------> | Simulator    |   | - Policy RAG Chat   |
| PDF / DOCX / CSV / TXT   |          +-------+------+   +-----+---------------+
+--------------------------+                  |                |
                                              +-------+--------+
                                                      |
                                              +-------v--------+
                                              | PostgreSQL DB  |
                                              | - PunchLog     |
                                              | - Exception    |
                                              | - AuditLog     |
                                              +----------------+
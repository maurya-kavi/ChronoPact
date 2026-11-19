# ChronoPact

ChronoPact is a governed Time and Attendance Exception Resolution Agent built for Dayforce Use Case 5. It detects workforce timecard anomalies before payroll cutoff, proposes policy-compliant corrections, and requires explicit human approval before any timecard mutation or immutable audit entry.

## Problem statement

Enterprise payroll teams must reconcile missed punches, breaks, overtime, schedule variance, leave conflicts, and rest-gap violations before cutoff. ChronoPact separates deterministic compliance calculation from generative reasoning: TypeScript detects and verifies compliance; open-weight AI explains and proposes corrections; HR retains the final approval authority.

## Model and license compliance

| Component | Model / Technology | License | Deployment |
|---|---|---|---|
| Primary reasoning LLM | `openai/gpt-oss-120b` | Apache 2.0 | Groq OpenAI-compatible inference API |
| Fallback and evaluation LLM | `openai/gpt-oss-20b` | Apache 2.0 | Groq OpenAI-compatible inference API |
| Local embeddings | `Xenova/all-MiniLM-L6-v2` | Apache 2.0 | 384-dimension embeddings via Transformers.js |
| Document parser | IBM Docling | MIT | Python FastAPI sidecar |

Groq is used only as an inference provider. The system can also point `LLM_BASE_URL` at a local Ollama OpenAI-compatible endpoint. Review upstream model and provider terms before production use.

## Architecture

```text
+-----------------------+       +------------------------------+
| React / Vite / Tailwind| -->   | Express / TypeScript API     |
| Employee + HR Views   |       | Zod routes, OpenAPI, Prisma  |
+----------+------------+       +-------+----------+-----------+
           |                            |          |
           |                    +-------v----+     v
           |                    |  Deterministic |  POST /punches
           |                    |  Rule Engine   |  POST /exceptions
           |                    +-------+--------+-----------+
           |                            |          |
+----------v------------+       +-------v----+ +---v----------------+
| IBM Docling Sidecar   | -->   | PostgreSQL | | Qdrant Hybrid RAG  |
| PDF / DOCX / TXT      |       | Prisma     | | Region + category   |
+-----------------------+       +------------+ | metadata filtering |
                                             +---------------------+
```

## Five-layer harness guardrails

1. **Deterministic detection:** TypeScript computes gross/net time, breaks, overtime, shift variance, leave conflict, rest gap, and punch sequence.
2. **Metadata-filtered policy RAG:** Qdrant retrieves region and anomaly-category matching policy clauses; PostgreSQL is the fallback.
3. **Strict Zod schema and retry:** LLM output is JSON validated up to three attempts, with validation errors sent back to the model.
4. **Post-fix simulation gate:** Every proposed punch sequence is re-evaluated before it is shown as verified.
5. **Human approval:** HR must approve, edit and approve, or escalate. Resolutions mutate PunchLog only through an explicit action and create an immutable AuditLog record.

## Monorepo layout

```text
backend/          Express, Prisma, deterministic engine, RAG, LLM, APIs
frontend/         React, Vite, Tailwind, Employee and HR dashboards
docling-service/  FastAPI and IBM Docling PDF/DOCX/TXT parser
```

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Python 3.11+
- Docker or an accessible Qdrant instance

### Backend

```bash
cd backend
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed
npm run dev
```

Backend API: `http://localhost:4000`  
Swagger: `http://localhost:4000/api-docs`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend: `http://localhost:5173`

### Docling sidecar

```bash
cd docling-service
python -m venv .venv
# Windows
.venv/Scripts/activate
# macOS/Linux
# source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

### Environment variables

```env
PORT=4000
DATABASE_URL="postgresql://postgres:password@localhost:5432/chronopact?schema=public"
GROQ_API_KEY=""
LLM_BASE_URL="https://api.groq.com/openai/v1"
LLM_MODEL="openai/gpt-oss-120b"
LLM_EVAL_MODEL="openai/gpt-oss-20b"
OLLAMA_BASE_URL="http://localhost:11434/v1"
QDRANT_URL="http://localhost:6333"
QDRANT_API_KEY=""
DOCLING_SERVICE_URL="http://localhost:8001"
VITE_API_BASE_URL="http://localhost:4000/api"
```

Start Qdrant locally with:

```bash
docker run -d --name chronopact-qdrant -p 6333:6333 qdrant/qdrant:latest
```

## Tests and benchmarks

```bash
cd backend
npm test
npm run build
npm run eval:llm

cd ../frontend
npm run build

cd ..
python -m py_compile docling-service/main.py
```

`npm test` excludes live LLM calls and always runs offline. `npm run eval:llm` automatically skips live assertions when `GROQ_API_KEY` is absent.

## Sample evaluation benchmark

| Anomaly | Expected Policy | Guardrail | Schema |
|---|---|---|---|
| MISSED_CLOCK_OUT | POL-PUNCH-01 | Pass | Pass |
| MISSING_MANDATORY_MEAL_BREAK | POL-BRK-01 | Pass | Pass |
| INVALID_PUNCH_SEQUENCE | POL-PUNCH-02 | Pass | Pass |
| UNAPPROVED_DAILY_OVERTIME | POL-OT-01 | Pass | Pass |

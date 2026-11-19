# ChronoPact

ChronoPact is a governed time and attendance exception-resolution agent. It detects anomalies before payroll cutoff, proposes policy-compliant corrections, and requires explicit HR or manager approval before any timecard mutation or payroll state change.

## Monorepo architecture

- `backend/` - Node.js, Express, TypeScript, Prisma, PostgreSQL, Zod, Groq-compatible OpenAI SDK, Qdrant, local embeddings, OpenAPI, and Vitest.
- `frontend/` - React and Vite employee/HR application shell with Tailwind CSS and Lucide icons.
- `docling-service/` - Python FastAPI sidecar that parses PDF and DOCX policy documents with Docling.

## Local setup

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Python 3.11+
- Docker or a local Qdrant instance

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

The API is available at `http://localhost:4000`, health checks at `/health`, and Swagger UI at `/api-docs`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Docling sidecar

```bash
cd docling-service
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

For Unix-like shells, activate the virtual environment with `source .venv/bin/activate`.

### Qdrant

```bash
docker run -d --name chronopact-qdrant -p 6333:6333 qdrant/qdrant:latest
```

## Model and License Compliance

ChronoPact uses open-weight models only. The default Groq configuration uses `llama-3.3-70b-versatile`, which is distributed under the Llama 3.3 Community License. For faster evaluation and tests, `llama-3.1-8b-instant` is available. Groq Cloud access is configured through the OpenAI-compatible endpoint `https://api.groq.com/openai/v1`.

The model provider is configurable through environment variables. Set `LLM_BASE_URL=http://localhost:11434/v1` for local Ollama compatibility, and set `LLM_MODEL` to an installed Ollama model. Llama model terms and applicable redistribution/use restrictions must be reviewed before deployment. A Groq API key or local provider remains responsible for model execution.

Embeddings use local `Xenova/all-MiniLM-L6-v2` (384 dimensions); no external embedding API is required.

## Design guardrails

All time arithmetic, overtime calculations, break checks, rest-gap checks, schedule conflicts, and leave conflicts are implemented deterministically. LLM output is never used to detect anomalies or perform time arithmetic. AI proposals are validated with Zod, simulated through the deterministic guardrails, and remain proposed until an explicit human resolution is recorded in the immutable audit log.

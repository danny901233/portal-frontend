## ReceptionMate Portal

ReceptionMate is an end-to-end portal for reviewing AI-assisted phone calls. A LiveKit-based voice agent posts call payloads into this system, which stores them in PostgreSQL and exposes a secure dashboard for operators.

### Tech Stack

- **Frontend:** Next.js 14 (App Router), TypeScript, TailwindCSS, TanStack React Query, Axios
- **Backend:** Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, JWT auth, Zod validation

---

## Prerequisites

- Node.js 18+
- npm 9+
- PostgreSQL 14+ (or compatible managed instance)

---

## Environment Configuration

### Frontend

Copy `.env.local.example` into `.env.local` at the repository root and adjust URLs if required:

```bash
cp .env.local.example .env.local
# edit NEXT_PUBLIC_API_BASE_URL if your backend runs on a different host
```

### Backend

Copy `backend/.env.example` into `backend/.env` and configure secrets/database credentials:

```bash
cp backend/.env.example backend/.env
# update PORT, DATABASE_URL, JWT_SECRET, etc.
```

---

## Installation & Setup

Install dependencies for both frontend and backend:

```bash
# from repo root
npm install

cd backend
npm install
```

Generate the Prisma client, run migrations, and seed an initial admin user/garage:

```bash
cd backend
npm run prisma:generate
npm run migrate:dev
npm run seed
```

The seed script respects the `SEED_*` variables defined in `backend/.env`; default credentials are `admin@receptionmate.ai` / `ChangeMe123!` with garage ID `d5a97619-c212-4c22-8973-fc946b06ad59`.

---

## Running the Stack Locally

Run the backend API on port 4000:

```bash
cd backend
npm run dev
```

In a separate terminal, start the Next.js frontend (defaults to port 3000):

```bash
npm run dev
```

Log in at `http://localhost:3000/login` using the seeded credentials. The dashboard under `/calls` provides a LiveKit-style SaaS UI with a call list and detailed transcript view.

---

## Webhook

The LiveKit AI agent should POST call payloads to the backend endpoint:

```
POST http://localhost:4000/api/calls
Headers: Optional `x-webhook-secret: <secret>` if configured
Body: {
	"garageId": "<uuid>",
	"roomName": "playground-1234",
	"recordingUrl": "https://...",
	"metrics": { "llm_prompt_tokens": 0, ... },
	"transcript": [{ "speaker": "user", "text": "hello", "timestamp": 123456 }],
	"summary": "User said hello"
}
```

Calls are automatically associated with garages (created on demand) and made available through the protected routes:

- `POST /api/calls`
- `GET /api/garages/:garageId/calls`
- `GET /api/garages/:garageId/calls/:callId`
- `POST /api/auth/login`

---

## Production Notes

- Use a strong `JWT_SECRET` and configure HTTPS/secure deployment settings.
- For multi-garage access, provision user records with hashed passwords via Prisma or an admin workflow.
- Consider enabling Prisma logging only in development (already configured).
- Remember to rotate the optional webhook secret regularly.

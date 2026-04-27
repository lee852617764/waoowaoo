# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

waoowaoo is an AI-powered short film/comic video production studio. It parses novels into characters, scenes, and storyboards, then generates images, videos, voiceovers, and assembles them into finished videos. It is a Next.js 15 + React 19 application with background job workers, a graph-based workflow engine, and an asset hub for reusable characters/locations/voices.

## Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4
- **Database**: MySQL 8 + Prisma ORM
- **Queue/Cache**: Redis + BullMQ
- **Storage**: MinIO (S3-compatible) or local filesystem
- **Auth**: NextAuth.js v4
- **i18n**: next-intl (zh / en)
- **Testing**: Vitest (fork pool, 30s timeout)
- **Logging**: Unified structured JSON logging with project-level log files

## Common Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start full dev stack: Next.js (turbopack) + workers + watchdog + Bull Board concurrently |
| `npm run dev:next` | Next.js only (turbopack, `-H 0.0.0.0`) |
| `npm run dev:worker` | Background workers only (image/video/voice/text queues) |
| `npm run build` | Production build (`prisma generate && next build`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:all` | ESLint across entire repo |
| `npm run verify:commit` | Lint + typecheck + all tests (runs on pre-commit) |
| `npm run verify:push` | Lint + typecheck + all tests + build (runs on pre-push) |

### Running Tests

All tests use Vitest. Tests are organized under `tests/`:

| Command | Purpose |
|---------|---------|
| `npm run test:unit:all` | All unit tests (no DB bootstrap) |
| `npm run test:integration:api` | API integration tests |
| `npm run test:integration:chain` | Workflow chain integration tests |
| `npm run test:integration:task` | Task system integration tests |
| `npm run test:billing:coverage` | Billing unit + integration + concurrency with coverage |
| `npm run test:system` | System tests |
| `npm run test:regression:cases` | Regression tests |
| `npm run test:all` | Full test suite (guards + unit + integration + system + regression) |
| `npm run test:pr` | Full suite wrapped in regression runner script |

Run a single test file:
```bash
npx vitest run path/to/file.test.ts
```

Some tests require `BILLING_TEST_BOOTSTRAP=1` (sets up test DB). Others use `BILLING_TEST_BOOTSTRAP=0` to skip bootstrap. Tests block external network calls unless to `localhost`/`127.0.0.1`.

### Running a Single Guard Script

```bash
npm run check:api-handler
npm run check:no-api-direct-llm-call
npm run check:test-coverage-guards
```

### Database

```bash
# Initialize schema (required on first setup)
npx prisma db push

# Generate client after schema changes
npx prisma generate
```

### Local Dev Infrastructure

```bash
# Start MySQL (13306), Redis (16379), MinIO (19000)
docker compose up mysql redis minio -d
```

## High-Level Architecture

### Multi-Process Runtime

The production runtime consists of four concurrent processes:
1. **Next.js web server** (`start:next`) - serves pages and API routes
2. **Workers** (`start:worker`) - BullMQ consumers for image, video, voice, and text queues
3. **Watchdog** (`start:watchdog`) - monitors task heartbeats and recovers stalled jobs
4. **Bull Board** (`start:board`) - admin UI for queue inspection (port 3010)

### Task System (Legacy + GraphRun)

There are two overlapping execution systems:

- **Legacy Task System** (`src/lib/task/`): Tasks are queued BullMQ jobs with status `queued | running | completed | failed | cancelled`. The `Task` table tracks progress, attempts, and billing. `task-target-states` API provides SSE progress streaming to the client.
- **GraphRun Workflow Engine** (`src/lib/run-runtime/`, `src/lib/workflow-engine/`): Newer graph-based execution. A `GraphRun` consists of `GraphStep`s, each with retryable `GraphStepAttempt`s. Steps publish events (`GraphEvent`) streamed via SSE. Checkpoints allow resumable execution. The workflow engine has a dependency graph and registry for step types.

Workers dispatch jobs based on task type. The `run-runtime` handles lease-based execution to prevent concurrent worker conflicts.

### Model Gateway & AI Runtime

- **`src/lib/model-gateway/`**: Routes AI provider requests. Supports OpenAI-compatible APIs, Google Gemini, FAL, OpenRouter, Volcano Engine (ARK), and Alibaba Bailian (Qwen). Custom providers can be configured per-user.
- **`src/lib/ai-runtime/`**: Higher-level abstraction for executing AI text/vision steps with standardized error handling.
- **`src/lib/model-capabilities/`**: Declares what each model can do (image generation, video generation, TTS, etc.)
- **`src/lib/model-pricing/`**: Cost calculation per model/action.

Guard scripts enforce that API routes never call LLMs directly — they must go through the model gateway.

### Novel Promotion Pipeline

The core product workflow lives under `src/lib/novel-promotion/` and `src/app/api/novel-promotion/`:

1. **Story Import** - Parse novel text into episodes
2. **Character Extraction** - AI extracts characters with profiles
3. **Location Extraction** - AI extracts scenes/locations
4. **Clip Splitting** - Episode divided into clips
5. **Storyboard Generation** - Clips become storyboards with panels
6. **Image Generation** - Panels get images (character-aware, location-aware)
7. **Video Generation** - Images become videos (optional lip-sync)
8. **Voice/TTS** - Dialogue lines synthesized with character-specific voices
9. **Video Editor / Assembly** - `VideoEditorProject` stores Remotion-based edit data

Key models: `NovelPromotionProject`, `NovelPromotionEpisode`, `NovelPromotionClip`, `NovelPromotionStoryboard`, `NovelPromotionPanel`, `NovelPromotionCharacter`, `NovelPromotionLocation`, `NovelPromotionVoiceLine`.

### Asset Hub

Global reusable assets stored per-user under `src/app/api/asset-hub/` and `src/lib/assets/`:
- **Characters** (`GlobalCharacter` + `GlobalCharacterAppearance`) with art-style-tagged images
- **Locations** (`GlobalLocation` + `GlobalLocationImage`)
- **Voices** (`GlobalVoice`) - custom-designed or uploaded voice presets
- Organized into flat folders (`GlobalAssetFolder`)

Assets can be copied into specific novel promotion projects. Character references and location references are injected into image generation prompts to maintain visual consistency.

### Media & Storage

- **`src/lib/storage/`**: Abstracted storage provider (MinIO/S3 or local). All uploaded/generated media gets a `storageKey`.
- **`MediaObject` table**: Canonical reference for every media file (images, videos, audio). Replaces legacy URL strings. Relations exist from panels, characters, locations, voice lines, etc.
- **Migration scripts**: `migrate-image-urls-contract.ts`, `media-backfill-refs.ts` migrate legacy URL columns to `MediaObject` references.

### Billing

- **`src/lib/billing/`**: Ledger-based accounting with `UserBalance`, `BalanceFreeze`, and `BalanceTransaction`.
- Billing can be `OFF` (default in dev), but the code paths remain active.
- Every task records `billingInfo` and usage costs are written to `UsageCost`.

### Logging

- Unified structured logging in `src/lib/logging/`.
- Use `createScopedLogger({ module: '...' })` and log methods like `logInfo`, `logError`.
- Logs are written to `logs/app.log` and per-project files `logs/projects/{projectId}/...`.
- Sensitive keys are redacted automatically.

## Code Conventions & Restrictions

- **Icons**: Always import through `@/components/ui/icons`. Direct `lucide-react` imports are blocked by ESLint.
- **No inline SVG**: Use `AppIcon` or the icons module.
- **Path alias**: `@/*` maps to `src/*`.
- **Locale routing**: App pages live under `src/app/[locale]/`. API routes are under `src/app/api/` (no locale prefix). The `/m/` path is excluded from i18n middleware.
- **Prisma**: Schema at `prisma/schema.prisma`. Client auto-generated on `postinstall`.

## Important Guard Scripts

The repo has many architecture-enforcing guard scripts under `scripts/guards/`:

- `no-api-direct-llm-call` - API routes must not import LLM clients directly
- `no-hardcoded-model-capabilities` - Capabilities must come from catalog, not hardcoded
- `no-provider-guessing` - Provider resolution must be explicit
- `no-model-key-downgrade` - Prevents silently falling back to cheaper models
- `no-server-mirror-state` - Prevents server-side state mirroring anti-patterns
- `no-multiple-sources-of-truth` - Prevents duplicate state sources
- `api-route-contract-guard` - Validates API route consistency
- `test-*-coverage` - Ensures tests cover routes and task types
- `prompt-i18n-guard` - Ensures prompt files have both `.en.txt` and `.zh.txt`

These are part of CI. Do not bypass them.

## Environment Setup

Copy `.env.example` to `.env` and fill in API keys. For local dev:
- MySQL on `13306`
- Redis on `16379`
- MinIO on `19000`
- App on `3000`
- Bull Board on `3010`

Required env vars: `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `REDIS_HOST`, `REDIS_PORT`, `STORAGE_TYPE` + storage credentials, `API_ENCRYPTION_KEY`.

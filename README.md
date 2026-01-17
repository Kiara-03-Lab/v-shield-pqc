# Narratrace

> **Logs exist. Explanations don't.**

Narratrace is an open-source system that turns low-level system events into **human-readable, evidence-backed narratives** explaining *why* something happened.

```
Observability tells you what happened.
Narratrace tells you why.
```

## Problem

Modern systems generate massive amounts of logs, traces, and audit events, but:

- Incident retrospectives require painful manual reconstruction
- Compliance evidence is screenshot-driven and brittle  
- Non-engineers cannot interpret raw observability data
- Existing tools optimize for **metrics**, not **meaning**

**Result:** Organizations know *what* happened, but not *why*.

## Solution

Narratrace provides **explainability for operations** by producing:

- **Plain-English narratives** - Human-readable stories, not dashboards
- **Verifiable evidence bundles** - Every claim backed by raw events
- **Queryable timelines** - Decisions and changes over time

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test
```

The server starts at `http://localhost:3000`.

## API Reference

### Ingest Events

```bash
# Direct event ingestion
curl -X POST http://localhost:3000/ingest/events \
  -H "Content-Type: application/json" \
  -d '{
    "time": "2024-01-15T10:00:00Z",
    "source": { "system": "github", "adapter": "github" },
    "kind": "PR_MERGED",
    "actor": { "type": "user", "id": "alice", "display": "Alice Smith" },
    "target": { "type": "service", "id": "payments", "display": "payments-service" },
    "action": "pull_request.merged",
    "outcome": "SUCCESS",
    "correlation": { "pr_number": "42", "commit_sha": "abc123" }
  }'

# Via adapter webhook
curl -X POST http://localhost:3000/ingest/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -d '{ ... GitHub webhook payload ... }'
```

### Query Episodes & Narratives

```bash
# List all episodes
curl http://localhost:3000/episodes

# Get episode with events
curl http://localhost:3000/episodes/{id}

# Get human-readable narrative
curl http://localhost:3000/episodes/{id}/narrative

# Export evidence bundle
curl http://localhost:3000/episodes/{id}/evidence
```

## Core Concepts

### NormalizedEvent

All inputs are converted to a canonical format:

```json
{
  "id": "01HQXX...",
  "time": "2024-01-15T10:00:00Z",
  "source": { "system": "github", "adapter": "github" },
  "kind": "DEPLOYMENT",
  "actor": { "type": "user", "id": "alice", "display": "Alice" },
  "target": { "type": "service", "id": "app", "display": "My App", "env": "prod" },
  "action": "deployment.created",
  "outcome": "SUCCESS",
  "correlation": { "commit_sha": "abc123", "pr_number": "42" },
  "evidence": { "raw_ref": "blob-id", "hash": "sha256..." }
}
```

### Episode

A causal unit of explanation (e.g., a deployment, feature flag change, access grant):

```json
{
  "id": "01HQXX...",
  "type": "DeploymentEpisode",
  "start_time": "2024-01-15T10:00:00Z",
  "end_time": "2024-01-15T10:10:00Z",
  "events": ["event-1", "event-2", "event-3"],
  "graph": {
    "nodes": ["event-1", "event-2", "event-3"],
    "edges": [
      { "from": "event-1", "to": "event-2", "type": "CAUSES" }
    ]
  }
}
```

### Narrative

Human-readable explanation with citations:

```json
{
  "title": "Deployment: payments-service rolled out to prod",
  "summary": "On January 15th, Alice deployed version abc123...",
  "timeline": [
    "10:02 – PR #42 merged",
    "10:07 – Deployment started",
    "10:09 – Rollout completed"
  ],
  "why": [
    "The deployment occurred because PR #42 was approved and merged",
    "The rollout was authorized by the release pipeline"
  ],
  "impact": "No errors detected post-deploy",
  "confidence": 0.86,
  "citations": [
    { "claim_id": "why-1", "event_id": "event-1" }
  ]
}
```

## Adapters

### Built-in Adapters

| Adapter | System | Events |
|---------|--------|--------|
| `github` | GitHub | PR merges, deployments, pushes |
| `otel` | OpenTelemetry | Logs, traces |
| `feature_flag` | LaunchDarkly, Unleash, generic | Flag changes |

### Webhook Endpoints

```
POST /ingest/webhook/github     # GitHub webhooks
POST /ingest/webhook/otel       # OTLP HTTP
POST /ingest/webhook/feature_flag # Feature flag systems
```

## Architecture

```
┌─────────────────┐
│  Source System  │  (GitHub, K8s, LaunchDarkly, etc.)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Adapter     │  Normalizes system-specific payloads
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Ingestion API  │  POST /ingest/events
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Storage      │  Events, Episodes, Narratives, Blobs
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Correlation    │  Groups events into Episodes
│     Engine      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Narrative     │  Generates human-readable explanations
│     Engine      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   API / UI      │  Query, read, export
└─────────────────┘
```

## Security

### Redaction

Sensitive data is automatically redacted:

- Keys: `password`, `token`, `secret`, `api_key`, `authorization`
- Patterns: JWTs, AWS keys, GitHub tokens, long secrets

### Evidence Integrity

- All raw payloads are SHA256 hashed
- Narratives cite event IDs + hashes
- Evidence bundles include complete audit trails

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Run tests
npm test

# Run tests in watch mode  
npm run test:watch

# Build for production
npm run build

# Start production server
npm start
```

## Project Structure

```
narratrace/
├── src/
│   ├── adapters/       # System adapters (GitHub, OTel, etc.)
│   ├── api/            # Express API server
│   ├── engine/         # Correlation & Narrative engines
│   ├── storage/        # Storage interface & implementations
│   ├── types/          # TypeScript schemas (Zod)
│   ├── utils/          # Helpers (hashing, redaction, etc.)
│   └── index.ts        # Entry point
├── tests/              # Test files
└── package.json
```

## Roadmap

- [x] **Milestone 1: MVP**
  - Core schema & types
  - Event ingestion API
  - Correlation engine
  - Template-based narratives
  - GitHub + OTel adapters
  
- [ ] **Milestone 2: Compliance-grade**
  - Postgres storage
  - RBAC
  - Read audit logs
  - Evidence export UI

- [ ] **Milestone 3: Ecosystem**
  - Plugin system for adapters
  - Community episode templates
  - Kubernetes adapter
  - IAM/Cloud audit adapters

- [ ] **Milestone 4: LLM Enhancement**
  - Optional prose improvement
  - Strict citation preservation
  - Fully disableable

## License

Apache-2.0

---

**Observability tells you what happened. Narratrace tells you why.**

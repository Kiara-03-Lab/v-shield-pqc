import { z } from 'zod';

// ============================================
// Source Information
// ============================================
export const SourceSchema = z.object({
  system: z.enum(['github', 'kubernetes', 'otel', 'iam', 'feature_flag', 'custom']),
  adapter: z.string(),
  instance: z.string().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

// ============================================
// Actor (who performed the action)
// ============================================
export const ActorSchema = z.object({
  type: z.enum(['user', 'service', 'system']),
  id: z.string(),
  display: z.string(),
  org: z.string().optional(),
});

export type Actor = z.infer<typeof ActorSchema>;

// ============================================
// Target (what was affected)
// ============================================
export const TargetSchema = z.object({
  type: z.enum(['service', 'env', 'resource', 'model', 'feature', 'user']),
  id: z.string(),
  display: z.string(),
  env: z.string().optional(),
  region: z.string().optional(),
});

export type Target = z.infer<typeof TargetSchema>;

// ============================================
// Event Kind
// ============================================
export const EventKindSchema = z.enum([
  'DEPLOYMENT',
  'FEATURE_FLAG',
  'MODEL_DECISION',
  'ACCESS_GRANT',
  'ACCESS_REVOKE',
  'INCIDENT',
  'PR_MERGED',
  'PR_OPENED',
  'PR_APPROVED',
  'CONFIG_CHANGE',
  'TRACE',
  'CUSTOM',
]);

export type EventKind = z.infer<typeof EventKindSchema>;

// ============================================
// Outcome
// ============================================
export const OutcomeSchema = z.enum(['SUCCESS', 'FAILURE', 'UNKNOWN', 'PENDING']);

export type Outcome = z.infer<typeof OutcomeSchema>;

// ============================================
// Correlation (links between events)
// ============================================
export const CorrelationSchema = z.object({
  trace_id: z.string().optional(),
  commit_sha: z.string().optional(),
  pr_number: z.string().optional(),
  ticket_id: z.string().optional(),
  deployment_id: z.string().optional(),
  parent_event_id: z.string().optional(),
});

export type Correlation = z.infer<typeof CorrelationSchema>;

// ============================================
// Evidence
// ============================================
export const EvidenceSchema = z.object({
  raw_ref: z.string(),
  hash: z.string(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

// ============================================
// NormalizedEvent - Core data model
// ============================================
export const NormalizedEventSchema = z.object({
  id: z.string(),
  time: z.string().datetime(),
  source: SourceSchema,
  kind: EventKindSchema,
  actor: ActorSchema,
  target: TargetSchema,
  action: z.string(),
  outcome: OutcomeSchema,
  correlation: CorrelationSchema.optional(),
  attributes: z.record(z.unknown()).optional(),
  evidence: EvidenceSchema.optional(),
});

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// Input schema (without id, will be generated)
export const NormalizedEventInputSchema = NormalizedEventSchema.omit({ id: true });
export type NormalizedEventInput = z.infer<typeof NormalizedEventInputSchema>;

// ============================================
// Episode Types
// ============================================
export const EpisodeTypeSchema = z.enum([
  'DeploymentEpisode',
  'FlagEpisode',
  'AccessEpisode',
  'IncidentEpisode',
  'PRMergeEpisode',
  'CustomEpisode',
]);

export type EpisodeType = z.infer<typeof EpisodeTypeSchema>;

// ============================================
// Episode Graph
// ============================================
export const EdgeTypeSchema = z.enum(['CAUSES', 'TRIGGERS', 'RELATES_TO', 'FOLLOWS']);

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: EdgeTypeSchema,
});

export const EpisodeGraphSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(GraphEdgeSchema),
});

export type EpisodeGraph = z.infer<typeof EpisodeGraphSchema>;

// ============================================
// Episode - Causal unit of explanation
// ============================================
export const EpisodeSchema = z.object({
  id: z.string(),
  type: EpisodeTypeSchema,
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  primary_actor: ActorSchema.optional(),
  primary_target: TargetSchema.optional(),
  events: z.array(z.string()),
  graph: EpisodeGraphSchema,
});

export type Episode = z.infer<typeof EpisodeSchema>;

// ============================================
// Citation
// ============================================
export const CitationSchema = z.object({
  claim_id: z.string(),
  event_id: z.string(),
  event_hash: z.string().optional(),
});

export type Citation = z.infer<typeof CitationSchema>;

// ============================================
// Narrative - Human-readable explanation
// ============================================
export const NarrativeSchema = z.object({
  id: z.string(),
  episode_id: z.string(),
  title: z.string(),
  summary: z.string(),
  timeline: z.array(z.string()),
  why: z.array(z.string()),
  what_changed: z.array(z.string()).optional(),
  impact: z.string().optional(),
  confidence: z.number().min(0).max(1),
  citations: z.array(CitationSchema),
  generated_at: z.string().datetime(),
});

export type Narrative = z.infer<typeof NarrativeSchema>;

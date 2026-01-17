import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorage } from '../src/storage/storage.js';
import { CorrelationEngine } from '../src/engine/correlation.js';
import { NarrativeEngine } from '../src/engine/narrative.js';
import { GitHubAdapter } from '../src/adapters/github.js';
import { OpenTelemetryAdapter } from '../src/adapters/otel.js';
import { FeatureFlagAdapter } from '../src/adapters/feature-flag.js';
import { generateId, hashPayload, redactSensitiveData } from '../src/utils/helpers.js';
import type { NormalizedEvent } from '../src/types/schemas.js';

describe('Narratrace Core', () => {
  let storage: InMemoryStorage;
  let correlationEngine: CorrelationEngine;
  let narrativeEngine: NarrativeEngine;

  beforeEach(() => {
    storage = new InMemoryStorage();
    correlationEngine = new CorrelationEngine(storage);
    narrativeEngine = new NarrativeEngine(storage);
  });

  describe('Utilities', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(26); // ULID length
    });

    it('should hash payloads consistently', () => {
      const payload = { foo: 'bar' };
      const hash1 = hashPayload(payload);
      const hash2 = hashPayload(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex length
    });

    it('should redact sensitive data', () => {
      const data = {
        username: 'alice',
        password: 'secret123',
        token: 'abc123',
        nested: {
          api_key: 'key123',
          safe_value: 'hello',
        },
      };

      const redacted = redactSensitiveData(data) as any;
      expect(redacted.username).toBe('alice');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.nested.api_key).toBe('[REDACTED]');
      expect(redacted.nested.safe_value).toBe('hello');
    });

    it('should redact JWT patterns in strings', () => {
      const jwt = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const redacted = redactSensitiveData(jwt);
      expect(redacted).toContain('[REDACTED]');
      expect(redacted).not.toContain('eyJ');
    });
  });

  describe('GitHub Adapter', () => {
    const adapter = new GitHubAdapter();

    it('should normalize PR merge event', () => {
      const payload = {
        action: 'closed',
        sender: { login: 'alice', name: 'Alice Smith' },
        repository: { id: 1, name: 'my-app', full_name: 'org/my-app' },
        pull_request: {
          number: 123,
          title: 'Add new feature',
          merged: true,
          merge_commit_sha: 'abc123def456',
          updated_at: '2024-01-15T10:00:00Z',
          additions: 50,
          deletions: 10,
          changed_files: 5,
          head: { sha: 'head123', ref: 'feature-branch' },
          base: { ref: 'main' },
        },
      };

      const events = adapter.normalize(payload);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.kind).toBe('PR_MERGED');
      expect(event.actor.display).toBe('Alice Smith');
      expect(event.target.id).toBe('org/my-app');
      expect(event.correlation?.pr_number).toBe('123');
      expect(event.correlation?.commit_sha).toBe('abc123def456');
      expect(event.outcome).toBe('SUCCESS');
    });

    it('should normalize deployment event', () => {
      const payload = {
        deployment: {
          id: 456,
          sha: 'deploy123',
          ref: 'main',
          task: 'deploy',
          environment: 'production',
          created_at: '2024-01-15T11:00:00Z',
        },
        sender: { login: 'bob' },
        repository: { id: 1, name: 'my-app', full_name: 'org/my-app' },
      };

      const events = adapter.normalize(payload);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.kind).toBe('DEPLOYMENT');
      expect(event.target.env).toBe('production');
      expect(event.correlation?.deployment_id).toBe('456');
    });
  });

  describe('OpenTelemetry Adapter', () => {
    const adapter = new OpenTelemetryAdapter();

    it('should normalize trace spans', () => {
      const payload = {
        resourceSpans: [{
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'payments-service' } },
              { key: 'deployment.environment', value: { stringValue: 'prod' } },
            ],
          },
          scopeSpans: [{
            spans: [{
              traceId: 'trace123',
              spanId: 'span456',
              name: 'HTTP GET /api/payments',
              kind: 2,
              startTimeUnixNano: '1705320000000000000',
              endTimeUnixNano: '1705320001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'http.status_code', value: { intValue: 200 } },
              ],
            }],
          }],
        }],
      };

      const events = adapter.normalize(payload);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.source.system).toBe('otel');
      expect(event.actor.id).toBe('payments-service');
      expect(event.target.env).toBe('prod');
      expect(event.correlation?.trace_id).toBe('trace123');
    });
  });

  describe('Feature Flag Adapter', () => {
    const adapter = new FeatureFlagAdapter();

    it('should normalize generic feature flag event', () => {
      const payload = {
        timestamp: '2024-01-15T12:00:00Z',
        flag: 'new-checkout-flow',
        flagName: 'New Checkout Flow',
        action: 'enabled',
        environment: 'production',
        actor: {
          type: 'user',
          id: 'alice@example.com',
          name: 'Alice',
        },
        enabled: true,
        previousEnabled: false,
      };

      const events = adapter.normalize(payload);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.kind).toBe('FEATURE_FLAG');
      expect(event.target.id).toBe('new-checkout-flow');
      expect(event.target.env).toBe('production');
      expect(event.attributes?.enabled).toBe(true);
    });
  });

  describe('Storage', () => {
    it('should store and retrieve events', async () => {
      const event: NormalizedEvent = {
        id: generateId(),
        time: new Date().toISOString(),
        source: { system: 'github', adapter: 'github' },
        kind: 'PR_MERGED',
        actor: { type: 'user', id: 'alice', display: 'Alice' },
        target: { type: 'service', id: 'my-app', display: 'My App' },
        action: 'pull_request.closed',
        outcome: 'SUCCESS',
        correlation: { pr_number: '123' },
      };

      await storage.saveEvent(event);
      const retrieved = await storage.getEvent(event.id);
      
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(event.id);
      expect(retrieved?.kind).toBe('PR_MERGED');
    });

    it('should query events by kind', async () => {
      const events: NormalizedEvent[] = [
        {
          id: generateId(),
          time: '2024-01-15T10:00:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'PR_MERGED',
          actor: { type: 'user', id: 'alice', display: 'Alice' },
          target: { type: 'service', id: 'app', display: 'App' },
          action: 'merge',
          outcome: 'SUCCESS',
        },
        {
          id: generateId(),
          time: '2024-01-15T11:00:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'DEPLOYMENT',
          actor: { type: 'user', id: 'alice', display: 'Alice' },
          target: { type: 'service', id: 'app', display: 'App' },
          action: 'deploy',
          outcome: 'SUCCESS',
        },
      ];

      await storage.saveEvents(events);

      const deployments = await storage.queryEvents({ kind: ['DEPLOYMENT'] });
      expect(deployments).toHaveLength(1);
      expect(deployments[0].kind).toBe('DEPLOYMENT');
    });
  });

  describe('Correlation Engine', () => {
    it('should correlate events by commit SHA', async () => {
      const events: NormalizedEvent[] = [
        {
          id: generateId(),
          time: '2024-01-15T10:00:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'PR_MERGED',
          actor: { type: 'user', id: 'alice', display: 'Alice' },
          target: { type: 'service', id: 'app', display: 'App' },
          action: 'merge',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123', pr_number: '42' },
        },
        {
          id: generateId(),
          time: '2024-01-15T10:05:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'DEPLOYMENT',
          actor: { type: 'service', id: 'ci', display: 'CI Pipeline' },
          target: { type: 'service', id: 'app', display: 'App', env: 'prod' },
          action: 'deploy',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123', deployment_id: '789' },
        },
      ];

      await storage.saveEvents(events);
      const episodes = await correlationEngine.correlate(events);

      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('DeploymentEpisode');
      expect(episodes[0].events).toHaveLength(2);
    });

    it('should create causal graph edges', async () => {
      const events: NormalizedEvent[] = [
        {
          id: 'event-1',
          time: '2024-01-15T10:00:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'PR_MERGED',
          actor: { type: 'user', id: 'alice', display: 'Alice' },
          target: { type: 'service', id: 'app', display: 'App' },
          action: 'merge',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123' },
        },
        {
          id: 'event-2',
          time: '2024-01-15T10:05:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'DEPLOYMENT',
          actor: { type: 'service', id: 'ci', display: 'CI' },
          target: { type: 'service', id: 'app', display: 'App' },
          action: 'deploy',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123' },
        },
      ];

      await storage.saveEvents(events);
      const episodes = await correlationEngine.correlate(events);

      const graph = episodes[0].graph;
      expect(graph.nodes).toContain('event-1');
      expect(graph.nodes).toContain('event-2');
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.edges.some(e => e.from === 'event-1' && e.to === 'event-2')).toBe(true);
    });
  });

  describe('Narrative Engine', () => {
    it('should generate deployment narrative', async () => {
      const events: NormalizedEvent[] = [
        {
          id: 'pr-event',
          time: '2024-01-15T10:00:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'PR_MERGED',
          actor: { type: 'user', id: 'alice', display: 'Alice Smith' },
          target: { type: 'service', id: 'payments', display: 'payments-service' },
          action: 'merge',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123', pr_number: '42' },
          attributes: { title: 'Add retry logic' },
          evidence: { raw_ref: 'ref1', hash: 'hash1' },
        },
        {
          id: 'deploy-event',
          time: '2024-01-15T10:05:00Z',
          source: { system: 'github', adapter: 'github' },
          kind: 'DEPLOYMENT',
          actor: { type: 'service', id: 'ci', display: 'CI Pipeline' },
          target: { type: 'service', id: 'payments', display: 'payments-service', env: 'production' },
          action: 'deploy',
          outcome: 'SUCCESS',
          correlation: { commit_sha: 'abc123', deployment_id: '789' },
          evidence: { raw_ref: 'ref2', hash: 'hash2' },
        },
      ];

      await storage.saveEvents(events);
      const episodes = await correlationEngine.correlate(events);
      const narrative = await narrativeEngine.generateNarrative(episodes[0]);

      expect(narrative.title).toContain('Deployment');
      expect(narrative.title).toContain('payments-service');
      expect(narrative.summary).toContain('Alice Smith');
      expect(narrative.summary).toContain('production');
      expect(narrative.timeline.length).toBeGreaterThan(0);
      expect(narrative.why.length).toBeGreaterThan(0);
      expect(narrative.citations.length).toBeGreaterThan(0);
      expect(narrative.confidence).toBeGreaterThan(0);
    });

    it('should generate feature flag narrative', async () => {
      const events: NormalizedEvent[] = [
        {
          id: 'flag-event',
          time: '2024-01-15T12:00:00Z',
          source: { system: 'feature_flag', adapter: 'launchdarkly' },
          kind: 'FEATURE_FLAG',
          actor: { type: 'user', id: 'bob', display: 'Bob Jones' },
          target: { type: 'feature', id: 'new-checkout', display: 'New Checkout Flow', env: 'production' },
          action: 'flag.enabled',
          outcome: 'SUCCESS',
          attributes: { 
            on: true, 
            previous_on: false,
            comment: 'Enabling for gradual rollout per JIRA-123',
          },
          correlation: { ticket_id: 'JIRA-123' },
          evidence: { raw_ref: 'ref1', hash: 'hash1' },
        },
      ];

      await storage.saveEvents(events);
      const episodes = await correlationEngine.correlate(events);
      const narrative = await narrativeEngine.generateNarrative(episodes[0]);

      expect(narrative.title).toContain('Feature Flag');
      expect(narrative.title).toContain('enabled');
      expect(narrative.summary).toContain('Bob Jones');
      expect(narrative.why.some(w => w.includes('JIRA-123'))).toBe(true);
    });
  });
});

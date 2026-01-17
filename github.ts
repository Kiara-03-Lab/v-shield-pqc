import type { Adapter } from './base.js';
import type { NormalizedEvent, EventKind, Outcome, Actor, Target } from '../types/index.js';
import { generateId, hashPayload, redactSensitiveData } from '../utils/index.js';

/**
 * GitHub Adapter
 * Handles: PR events, deployment events, push events
 */
export class GitHubAdapter implements Adapter {
  readonly name = 'github';
  readonly system = 'github';

  normalize(payload: unknown): NormalizedEvent[] {
    const data = payload as GitHubWebhookPayload;
    const events: NormalizedEvent[] = [];

    // Determine event type from payload structure
    if (data.pull_request && data.action) {
      events.push(...this.normalizePREvent(data));
    } else if (data.deployment) {
      events.push(...this.normalizeDeploymentEvent(data));
    } else if (data.pusher && data.commits) {
      events.push(...this.normalizePushEvent(data));
    }

    return events;
  }

  handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<NormalizedEvent[]> {
    const eventType = headers?.['x-github-event'];
    // The normalize function handles routing based on payload structure
    return Promise.resolve(this.normalize(payload));
  }

  private normalizePREvent(data: GitHubWebhookPayload): NormalizedEvent[] {
    const pr = data.pull_request!;
    const action = data.action!;
    
    let kind: EventKind;
    switch (action) {
      case 'opened':
        kind = 'PR_OPENED';
        break;
      case 'closed':
        kind = pr.merged ? 'PR_MERGED' : 'CUSTOM';
        break;
      case 'approved':
      case 'review_requested':
        kind = 'PR_APPROVED';
        break;
      default:
        kind = 'CUSTOM';
    }

    const actor = this.extractActor(data.sender);
    const target = this.extractRepoTarget(data.repository);

    const event: NormalizedEvent = {
      id: generateId(),
      time: pr.updated_at || new Date().toISOString(),
      source: {
        system: 'github',
        adapter: this.name,
        instance: data.repository?.full_name,
      },
      kind,
      actor,
      target,
      action: `pull_request.${action}`,
      outcome: this.determineOutcome(action, pr),
      correlation: {
        pr_number: String(pr.number),
        commit_sha: pr.merge_commit_sha || pr.head?.sha,
      },
      attributes: {
        title: pr.title,
        body: pr.body,
        base_branch: pr.base?.ref,
        head_branch: pr.head?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
      },
      evidence: {
        raw_ref: `github:pr:${data.repository?.full_name}:${pr.number}`,
        hash: hashPayload(redactSensitiveData(data)),
      },
    };

    return [event];
  }

  private normalizeDeploymentEvent(data: GitHubWebhookPayload): NormalizedEvent[] {
    const deployment = data.deployment!;
    const actor = this.extractActor(data.sender);
    const target: Target = {
      type: 'service',
      id: data.repository?.full_name || 'unknown',
      display: data.repository?.name || 'unknown',
      env: deployment.environment,
    };

    const event: NormalizedEvent = {
      id: generateId(),
      time: deployment.created_at || new Date().toISOString(),
      source: {
        system: 'github',
        adapter: this.name,
        instance: data.repository?.full_name,
      },
      kind: 'DEPLOYMENT',
      actor,
      target,
      action: 'deployment.created',
      outcome: 'PENDING',
      correlation: {
        commit_sha: deployment.sha,
        deployment_id: String(deployment.id),
      },
      attributes: {
        environment: deployment.environment,
        description: deployment.description,
        ref: deployment.ref,
        task: deployment.task,
      },
      evidence: {
        raw_ref: `github:deployment:${data.repository?.full_name}:${deployment.id}`,
        hash: hashPayload(redactSensitiveData(data)),
      },
    };

    return [event];
  }

  private normalizePushEvent(data: GitHubWebhookPayload): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const actor = this.extractActor(data.pusher as GitHubUser);
    const target = this.extractRepoTarget(data.repository);

    for (const commit of data.commits || []) {
      const event: NormalizedEvent = {
        id: generateId(),
        time: commit.timestamp || new Date().toISOString(),
        source: {
          system: 'github',
          adapter: this.name,
          instance: data.repository?.full_name,
        },
        kind: 'CUSTOM',
        actor: commit.author ? {
          type: 'user',
          id: commit.author.email || commit.author.username || 'unknown',
          display: commit.author.name || commit.author.username || 'Unknown',
        } : actor,
        target,
        action: 'push.commit',
        outcome: 'SUCCESS',
        correlation: {
          commit_sha: commit.id,
        },
        attributes: {
          message: commit.message,
          ref: data.ref,
          added: commit.added,
          removed: commit.removed,
          modified: commit.modified,
        },
        evidence: {
          raw_ref: `github:commit:${data.repository?.full_name}:${commit.id}`,
          hash: hashPayload(redactSensitiveData(commit)),
        },
      };
      events.push(event);
    }

    return events;
  }

  private extractActor(user?: GitHubUser): Actor {
    if (!user) {
      return { type: 'system', id: 'unknown', display: 'Unknown' };
    }
    return {
      type: 'user',
      id: user.login || user.email || 'unknown',
      display: user.name || user.login || 'Unknown',
    };
  }

  private extractRepoTarget(repo?: GitHubRepository): Target {
    if (!repo) {
      return { type: 'service', id: 'unknown', display: 'Unknown' };
    }
    return {
      type: 'service',
      id: repo.full_name,
      display: repo.name,
    };
  }

  private determineOutcome(action: string, pr: GitHubPullRequest): Outcome {
    if (action === 'closed') {
      return pr.merged ? 'SUCCESS' : 'FAILURE';
    }
    return 'SUCCESS';
  }
}

// ============================================
// GitHub Types (simplified)
// ============================================
interface GitHubUser {
  login?: string;
  name?: string;
  email?: string;
  username?: string;
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string;
  merged: boolean;
  merge_commit_sha?: string;
  updated_at?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head?: { sha: string; ref: string };
  base?: { ref: string };
}

interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description?: string;
  created_at?: string;
}

interface GitHubCommit {
  id: string;
  message: string;
  timestamp?: string;
  author?: GitHubUser;
  added?: string[];
  removed?: string[];
  modified?: string[];
}

interface GitHubWebhookPayload {
  action?: string;
  sender?: GitHubUser;
  repository?: GitHubRepository;
  pull_request?: GitHubPullRequest;
  deployment?: GitHubDeployment;
  pusher?: GitHubUser;
  commits?: GitHubCommit[];
  ref?: string;
}

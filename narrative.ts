import type { Episode, Narrative, NormalizedEvent, Citation } from '../types/index.js';
import type { Storage } from '../storage/index.js';
import { generateId, formatTime, formatDate, calculateConfidence } from '../utils/index.js';

/**
 * Narrative Engine
 * Generates human-readable explanations from Episodes
 * Uses template-based generation (no LLM required for MVP)
 */
export class NarrativeEngine {
  constructor(private storage: Storage) {}

  /**
   * Generate narrative for an episode
   */
  async generateNarrative(episode: Episode): Promise<Narrative> {
    const events = await this.storage.getEpisodeEvents(episode.id);
    
    const generator = this.getGenerator(episode.type);
    const narrative = generator.generate(episode, events);
    
    await this.storage.saveNarrative(narrative);
    return narrative;
  }

  /**
   * Get appropriate generator for episode type
   */
  private getGenerator(type: Episode['type']): NarrativeGenerator {
    switch (type) {
      case 'DeploymentEpisode':
        return new DeploymentNarrativeGenerator();
      case 'FlagEpisode':
        return new FlagNarrativeGenerator();
      case 'AccessEpisode':
        return new AccessNarrativeGenerator();
      case 'IncidentEpisode':
        return new IncidentNarrativeGenerator();
      case 'PRMergeEpisode':
        return new PRMergeNarrativeGenerator();
      default:
        return new GenericNarrativeGenerator();
    }
  }
}

/**
 * Base interface for narrative generators
 */
interface NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative;
}

/**
 * Deployment Episode Narrative Generator
 */
class DeploymentNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const deploymentEvents = events.filter(e => e.kind === 'DEPLOYMENT');
    const prEvents = events.filter(e => e.kind === 'PR_MERGED');
    const traceEvents = events.filter(e => e.kind === 'TRACE');
    
    const primaryDeployment = deploymentEvents[0];
    const actor = episode.primary_actor;
    const target = episode.primary_target;
    
    const title = `Deployment: ${target?.display || 'Unknown service'} deployed to ${target?.env || 'production'}`;
    
    const summary = this.buildSummary(primaryDeployment, actor, target, prEvents);
    const timeline = this.buildTimeline(events);
    const why = this.buildWhy(events, prEvents);
    const whatChanged = this.buildWhatChanged(events);
    const impact = this.buildImpact(events, traceEvents);
    const citations = this.buildCitations(events, why);
    
    const confidence = calculateConfidence({
      hasCommitSha: events.some(e => e.correlation?.commit_sha),
      hasTraceId: events.some(e => e.correlation?.trace_id),
      hasApprovalEvent: prEvents.some(e => e.kind === 'PR_APPROVED'),
      hasActor: !!actor,
      hasConflictingOutcomes: this.hasConflictingOutcomes(events),
    });

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      what_changed: whatChanged,
      impact,
      confidence,
      citations,
      generated_at: new Date().toISOString(),
    };
  }

  private buildSummary(
    deployment: NormalizedEvent | undefined,
    actor: Episode['primary_actor'],
    target: Episode['primary_target'],
    prEvents: NormalizedEvent[]
  ): string {
    if (!deployment) {
      return 'A deployment occurred but details are incomplete.';
    }

    const date = formatDate(deployment.time);
    const actorName = actor?.display || 'Someone';
    const serviceName = target?.display || 'a service';
    const env = target?.env || 'production';
    const version = deployment.correlation?.commit_sha?.slice(0, 7) || 'unknown version';
    
    let summary = `On ${date}, ${actorName} deployed ${serviceName} (${version}) to ${env}.`;
    
    if (prEvents.length > 0) {
      const prNumbers = prEvents.map(e => `#${e.correlation?.pr_number}`).join(', ');
      summary += ` This deployment included changes from PR ${prNumbers}.`;
    }
    
    return summary;
  }

  private buildTimeline(events: NormalizedEvent[]): string[] {
    return events.map(e => {
      const time = formatTime(e.time);
      const action = this.describeAction(e);
      return `${time} – ${action}`;
    });
  }

  private buildWhy(events: NormalizedEvent[], prEvents: NormalizedEvent[]): string[] {
    const reasons: string[] = [];
    
    if (prEvents.length > 0) {
      const pr = prEvents[0];
      reasons.push(
        `The deployment occurred because PR #${pr.correlation?.pr_number} was approved and merged`
      );
    }
    
    const deploymentEvent = events.find(e => e.kind === 'DEPLOYMENT');
    if (deploymentEvent) {
      reasons.push('The rollout was authorized by the release pipeline');
    }
    
    if (reasons.length === 0) {
      reasons.push('The deployment was triggered through the standard release process');
    }
    
    return reasons;
  }

  private buildWhatChanged(events: NormalizedEvent[]): string[] {
    const changes: string[] = [];
    
    for (const event of events) {
      if (event.kind === 'PR_MERGED' && event.attributes) {
        const attrs = event.attributes as Record<string, unknown>;
        if (attrs.title) {
          changes.push(String(attrs.title));
        }
      }
    }
    
    return changes;
  }

  private buildImpact(events: NormalizedEvent[], traceEvents: NormalizedEvent[]): string {
    const failedEvents = events.filter(e => e.outcome === 'FAILURE');
    
    if (failedEvents.length > 0) {
      return `Deployment encountered ${failedEvents.length} error(s) during rollout`;
    }
    
    if (traceEvents.length > 0) {
      const errorTraces = traceEvents.filter(e => e.outcome === 'FAILURE');
      if (errorTraces.length > 0) {
        return `${errorTraces.length} error(s) detected post-deployment`;
      }
      return 'Service is operating normally post-deployment';
    }
    
    const deploymentEvent = events.find(e => e.kind === 'DEPLOYMENT');
    if (deploymentEvent?.outcome === 'SUCCESS') {
      return 'Deployment completed successfully';
    }
    
    return 'Impact assessment pending';
  }

  private buildCitations(events: NormalizedEvent[], whyReasons: string[]): Citation[] {
    const citations: Citation[] = [];
    
    for (let i = 0; i < whyReasons.length; i++) {
      const relevantEvent = events.find(e => {
        if (whyReasons[i].includes('PR') && e.kind === 'PR_MERGED') return true;
        if (whyReasons[i].includes('rollout') && e.kind === 'DEPLOYMENT') return true;
        return false;
      });
      
      if (relevantEvent) {
        citations.push({
          claim_id: `why-${i + 1}`,
          event_id: relevantEvent.id,
          event_hash: relevantEvent.evidence?.hash,
        });
      }
    }
    
    return citations;
  }

  private describeAction(event: NormalizedEvent): string {
    switch (event.kind) {
      case 'PR_MERGED':
        return `PR #${event.correlation?.pr_number} merged`;
      case 'PR_APPROVED':
        return `PR #${event.correlation?.pr_number} approved`;
      case 'DEPLOYMENT':
        return `Deployment ${event.outcome === 'SUCCESS' ? 'completed' : 'started'}`;
      case 'TRACE':
        return `${event.action} executed`;
      default:
        return event.action;
    }
  }

  private hasConflictingOutcomes(events: NormalizedEvent[]): boolean {
    const deployments = events.filter(e => e.kind === 'DEPLOYMENT');
    const outcomes = new Set(deployments.map(e => e.outcome));
    return outcomes.has('SUCCESS') && outcomes.has('FAILURE');
  }
}

/**
 * Feature Flag Episode Narrative Generator
 */
class FlagNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const flagEvents = events.filter(e => e.kind === 'FEATURE_FLAG');
    const primaryFlag = flagEvents[0];
    const actor = episode.primary_actor;
    const target = episode.primary_target;

    const title = `Feature Flag: ${target?.display || 'Unknown flag'} ${this.getAction(primaryFlag)}`;
    
    const summary = this.buildSummary(primaryFlag, actor, target);
    const timeline = events.map(e => `${formatTime(e.time)} – ${this.describeAction(e)}`);
    const why = this.buildWhy(events);
    const whatChanged = this.buildWhatChanged(events);
    const citations = this.buildCitations(events, why);

    const confidence = calculateConfidence({
      hasCommitSha: events.some(e => e.correlation?.commit_sha),
      hasTraceId: events.some(e => e.correlation?.trace_id),
      hasApprovalEvent: false,
      hasActor: !!actor,
      hasConflictingOutcomes: false,
    });

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      what_changed: whatChanged,
      impact: this.buildImpact(events),
      confidence,
      citations,
      generated_at: new Date().toISOString(),
    };
  }

  private getAction(event: NormalizedEvent | undefined): string {
    if (!event) return 'changed';
    const attrs = event.attributes as Record<string, unknown>;
    if (attrs?.enabled === true || attrs?.on === true) return 'enabled';
    if (attrs?.enabled === false || attrs?.on === false) return 'disabled';
    return 'updated';
  }

  private buildSummary(
    event: NormalizedEvent | undefined,
    actor: Episode['primary_actor'],
    target: Episode['primary_target']
  ): string {
    if (!event) return 'A feature flag was changed.';

    const date = formatDate(event.time);
    const actorName = actor?.display || 'Someone';
    const flagName = target?.display || 'a feature flag';
    const action = this.getAction(event);
    const env = target?.env || 'all environments';

    return `On ${date}, ${actorName} ${action} the "${flagName}" feature flag in ${env}.`;
  }

  private buildWhy(events: NormalizedEvent[]): string[] {
    const reasons: string[] = [];
    
    for (const event of events) {
      const attrs = event.attributes as Record<string, unknown>;
      if (attrs?.comment) {
        reasons.push(`Change reason: "${attrs.comment}"`);
      }
      if (event.correlation?.ticket_id) {
        reasons.push(`Related to ticket ${event.correlation.ticket_id}`);
      }
    }

    if (reasons.length === 0) {
      reasons.push('No explicit reason was documented for this change');
    }

    return reasons;
  }

  private buildWhatChanged(events: NormalizedEvent[]): string[] {
    const changes: string[] = [];
    
    for (const event of events) {
      const attrs = event.attributes as Record<string, unknown>;
      if (attrs?.previous_on !== undefined && attrs?.on !== undefined) {
        const prev = attrs.previous_on ? 'enabled' : 'disabled';
        const curr = attrs.on ? 'enabled' : 'disabled';
        if (prev !== curr) {
          changes.push(`Flag state: ${prev} → ${curr}`);
        }
      }
      if (attrs?.targeting_rules) {
        changes.push(`Targeting rules: ${attrs.targeting_rules} rule(s) configured`);
      }
    }

    return changes;
  }

  private buildImpact(events: NormalizedEvent[]): string {
    const traces = events.filter(e => e.kind === 'TRACE');
    if (traces.length > 0) {
      return `${traces.length} trace event(s) recorded after flag change`;
    }
    return 'Impact assessment pending - no trace data available';
  }

  private describeAction(event: NormalizedEvent): string {
    const action = this.getAction(event);
    return `Flag ${action} by ${event.actor.display}`;
  }

  private buildCitations(events: NormalizedEvent[], whyReasons: string[]): Citation[] {
    return events.slice(0, whyReasons.length).map((e, i) => ({
      claim_id: `why-${i + 1}`,
      event_id: e.id,
      event_hash: e.evidence?.hash,
    }));
  }
}

/**
 * Access Episode Narrative Generator
 */
class AccessNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const grantEvents = events.filter(e => e.kind === 'ACCESS_GRANT');
    const revokeEvents = events.filter(e => e.kind === 'ACCESS_REVOKE');
    const actor = episode.primary_actor;
    const target = episode.primary_target;

    const action = grantEvents.length > revokeEvents.length ? 'granted' : 'revoked';
    const title = `Access ${action}: ${target?.display || 'Unknown resource'}`;

    const summary = this.buildSummary(events, actor, target, action);
    const timeline = events.map(e => `${formatTime(e.time)} – ${this.describeAction(e)}`);
    const why = [`Access was ${action} through the standard access management process`];
    const citations = events.slice(0, 1).map((e, i) => ({
      claim_id: `why-${i + 1}`,
      event_id: e.id,
      event_hash: e.evidence?.hash,
    }));

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      confidence: 0.8,
      citations,
      generated_at: new Date().toISOString(),
    };
  }

  private buildSummary(
    events: NormalizedEvent[],
    actor: Episode['primary_actor'],
    target: Episode['primary_target'],
    action: string
  ): string {
    const date = formatDate(events[0]?.time || new Date().toISOString());
    const actorName = actor?.display || 'Someone';
    const resourceName = target?.display || 'a resource';

    return `On ${date}, ${actorName} ${action} access to ${resourceName}.`;
  }

  private describeAction(event: NormalizedEvent): string {
    if (event.kind === 'ACCESS_GRANT') {
      return `Access granted to ${event.target.display} by ${event.actor.display}`;
    }
    return `Access revoked from ${event.target.display} by ${event.actor.display}`;
  }
}

/**
 * Incident Episode Narrative Generator
 */
class IncidentNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const target = episode.primary_target;

    const title = `Incident: ${target?.display || 'System'} experienced issues`;

    const summary = this.buildSummary(events, target);
    const timeline = events.map(e => `${formatTime(e.time)} – ${e.action}`);
    const why = ['Incident was automatically detected by monitoring systems'];
    const citations = events.slice(0, 1).map((e, i) => ({
      claim_id: `why-${i + 1}`,
      event_id: e.id,
      event_hash: e.evidence?.hash,
    }));

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      impact: `${events.length} event(s) recorded during incident`,
      confidence: 0.7,
      citations,
      generated_at: new Date().toISOString(),
    };
  }

  private buildSummary(events: NormalizedEvent[], target: Episode['primary_target']): string {
    const startTime = formatDate(events[0]?.time || new Date().toISOString());
    const serviceName = target?.display || 'The system';

    return `On ${startTime}, ${serviceName} experienced an incident that triggered ${events.length} alert(s).`;
  }
}

/**
 * PR Merge Episode Narrative Generator
 */
class PRMergeNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const prEvents = events.filter(e => e.kind.startsWith('PR_'));
    const mergeEvent = prEvents.find(e => e.kind === 'PR_MERGED');
    const actor = episode.primary_actor;
    const target = episode.primary_target;

    const prNumber = mergeEvent?.correlation?.pr_number || 'unknown';
    const title = `PR #${prNumber} merged into ${target?.display || 'repository'}`;

    const summary = this.buildSummary(mergeEvent, actor, target);
    const timeline = events.map(e => `${formatTime(e.time)} – ${this.describeAction(e)}`);
    const why = this.buildWhy(events);
    const whatChanged = this.buildWhatChanged(mergeEvent);
    const citations = events.slice(0, why.length).map((e, i) => ({
      claim_id: `why-${i + 1}`,
      event_id: e.id,
      event_hash: e.evidence?.hash,
    }));

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      what_changed: whatChanged,
      confidence: 0.9,
      citations,
      generated_at: new Date().toISOString(),
    };
  }

  private buildSummary(
    event: NormalizedEvent | undefined,
    actor: Episode['primary_actor'],
    target: Episode['primary_target']
  ): string {
    if (!event) return 'A pull request was merged.';

    const date = formatDate(event.time);
    const actorName = actor?.display || 'Someone';
    const repoName = target?.display || 'the repository';
    const attrs = event.attributes as Record<string, unknown>;
    const prTitle = attrs?.title || 'changes';

    return `On ${date}, ${actorName} merged "${prTitle}" into ${repoName}.`;
  }

  private buildWhy(events: NormalizedEvent[]): string[] {
    const reasons: string[] = [];
    
    const approvalEvent = events.find(e => e.kind === 'PR_APPROVED');
    if (approvalEvent) {
      reasons.push(`PR was approved by ${approvalEvent.actor.display}`);
    }

    const mergeEvent = events.find(e => e.kind === 'PR_MERGED');
    if (mergeEvent) {
      reasons.push('All merge requirements were satisfied');
    }

    return reasons.length > 0 ? reasons : ['PR was merged through standard review process'];
  }

  private buildWhatChanged(event: NormalizedEvent | undefined): string[] {
    if (!event?.attributes) return [];
    
    const attrs = event.attributes as Record<string, unknown>;
    const changes: string[] = [];

    if (attrs.additions || attrs.deletions) {
      changes.push(`${attrs.additions || 0} additions, ${attrs.deletions || 0} deletions`);
    }
    if (attrs.changed_files) {
      changes.push(`${attrs.changed_files} file(s) changed`);
    }

    return changes;
  }

  private describeAction(event: NormalizedEvent): string {
    switch (event.kind) {
      case 'PR_OPENED':
        return `PR opened by ${event.actor.display}`;
      case 'PR_APPROVED':
        return `PR approved by ${event.actor.display}`;
      case 'PR_MERGED':
        return `PR merged by ${event.actor.display}`;
      default:
        return event.action;
    }
  }
}

/**
 * Generic Narrative Generator (fallback)
 */
class GenericNarrativeGenerator implements NarrativeGenerator {
  generate(episode: Episode, events: NormalizedEvent[]): Narrative {
    const actor = episode.primary_actor;
    const target = episode.primary_target;

    const title = `Activity: ${target?.display || 'System'} - ${events.length} event(s)`;

    const summary = `Between ${formatDate(episode.start_time)} and ${formatDate(episode.end_time)}, ` +
      `${events.length} event(s) were recorded affecting ${target?.display || 'the system'}` +
      (actor ? ` by ${actor.display}` : '') + '.';

    const timeline = events.map(e => `${formatTime(e.time)} – ${e.action}`);
    const why = ['Events were captured through standard monitoring'];
    const citations = events.slice(0, 1).map((e, i) => ({
      claim_id: `why-${i + 1}`,
      event_id: e.id,
      event_hash: e.evidence?.hash,
    }));

    return {
      id: generateId(),
      episode_id: episode.id,
      title,
      summary,
      timeline,
      why,
      confidence: 0.5,
      citations,
      generated_at: new Date().toISOString(),
    };
  }
}

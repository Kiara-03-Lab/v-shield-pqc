import type { NormalizedEvent, Episode, EpisodeType, EpisodeGraph } from '../types/index.js';
import type { Storage } from '../storage/index.js';
import { generateId } from '../utils/index.js';

/**
 * Correlation Engine
 * Groups related events into Episodes based on:
 * - Correlation fields (trace_id, commit_sha, pr_number, deployment_id)
 * - Temporal proximity
 * - Causal relationships
 */
export class CorrelationEngine {
  constructor(private storage: Storage) {}

  /**
   * Correlate new events and create/update episodes
   */
  async correlate(events: NormalizedEvent[]): Promise<Episode[]> {
    const newEpisodes: Episode[] = [];
    const eventGroups = this.groupEvents(events);

    for (const [key, groupedEvents] of eventGroups) {
      const episodeType = this.determineEpisodeType(groupedEvents);
      const episode = this.createEpisode(groupedEvents, episodeType);
      await this.storage.saveEpisode(episode);
      newEpisodes.push(episode);
    }

    return newEpisodes;
  }

  /**
   * Recompute all episodes from stored events
   */
  async recompute(query?: { startTime?: string; endTime?: string }): Promise<Episode[]> {
    const events = await this.storage.queryEvents({
      startTime: query?.startTime,
      endTime: query?.endTime,
      limit: 10000,
    });

    return this.correlate(events);
  }

  /**
   * Group events by correlation keys
   */
  private groupEvents(events: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
    const groups = new Map<string, NormalizedEvent[]>();
    const eventToGroup = new Map<string, string>();

    for (const event of events) {
      const correlationKeys = this.getCorrelationKeys(event);
      
      // Find existing group or create new one
      let groupKey: string | null = null;
      
      for (const key of correlationKeys) {
        // Check if this correlation key already belongs to a group
        for (const [existingGroupKey, existingEvents] of groups) {
          for (const existingEvent of existingEvents) {
            const existingKeys = this.getCorrelationKeys(existingEvent);
            if (existingKeys.includes(key)) {
              groupKey = existingGroupKey;
              break;
            }
          }
          if (groupKey) break;
        }
        if (groupKey) break;
      }

      // If no existing group found, use primary correlation key or event ID
      if (!groupKey) {
        groupKey = correlationKeys[0] || `event:${event.id}`;
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(event);
      eventToGroup.set(event.id, groupKey);
    }

    // Merge groups that share correlation keys
    return this.mergeRelatedGroups(groups);
  }

  /**
   * Get correlation keys from an event
   */
  private getCorrelationKeys(event: NormalizedEvent): string[] {
    const keys: string[] = [];
    const c = event.correlation;

    if (c?.deployment_id) keys.push(`deployment:${c.deployment_id}`);
    if (c?.pr_number) keys.push(`pr:${event.source.instance}:${c.pr_number}`);
    if (c?.commit_sha) keys.push(`commit:${c.commit_sha}`);
    if (c?.trace_id) keys.push(`trace:${c.trace_id}`);
    if (c?.ticket_id) keys.push(`ticket:${c.ticket_id}`);

    return keys;
  }

  /**
   * Merge groups that are related through shared correlation
   */
  private mergeRelatedGroups(groups: Map<string, NormalizedEvent[]>): Map<string, NormalizedEvent[]> {
    const merged = new Map<string, NormalizedEvent[]>();
    const processed = new Set<string>();

    for (const [key, events] of groups) {
      if (processed.has(key)) continue;

      // Find all related groups
      const relatedEvents = [...events];
      const toMerge = [key];
      
      for (const [otherKey, otherEvents] of groups) {
        if (otherKey === key || processed.has(otherKey)) continue;

        // Check if groups share any correlation
        if (this.groupsAreRelated(events, otherEvents)) {
          relatedEvents.push(...otherEvents);
          toMerge.push(otherKey);
        }
      }

      // Mark all merged groups as processed
      for (const k of toMerge) {
        processed.add(k);
      }

      // Sort events by time
      relatedEvents.sort((a, b) => a.time.localeCompare(b.time));

      // Use the first key as the group key
      merged.set(key, relatedEvents);
    }

    return merged;
  }

  /**
   * Check if two groups of events are related
   */
  private groupsAreRelated(group1: NormalizedEvent[], group2: NormalizedEvent[]): boolean {
    const keys1 = new Set(group1.flatMap(e => this.getCorrelationKeys(e)));
    const keys2 = group2.flatMap(e => this.getCorrelationKeys(e));

    return keys2.some(k => keys1.has(k));
  }

  /**
   * Determine episode type based on events
   */
  private determineEpisodeType(events: NormalizedEvent[]): EpisodeType {
    const kinds = new Set(events.map(e => e.kind));

    if (kinds.has('DEPLOYMENT')) return 'DeploymentEpisode';
    if (kinds.has('FEATURE_FLAG')) return 'FlagEpisode';
    if (kinds.has('ACCESS_GRANT') || kinds.has('ACCESS_REVOKE')) return 'AccessEpisode';
    if (kinds.has('INCIDENT')) return 'IncidentEpisode';
    if (kinds.has('PR_MERGED')) return 'PRMergeEpisode';

    return 'CustomEpisode';
  }

  /**
   * Create an episode from a group of events
   */
  private createEpisode(events: NormalizedEvent[], type: EpisodeType): Episode {
    const sortedEvents = [...events].sort((a, b) => a.time.localeCompare(b.time));
    const graph = this.buildCausalGraph(sortedEvents);

    // Find primary actor (most common or first)
    const actorCounts = new Map<string, { actor: NormalizedEvent['actor']; count: number }>();
    for (const event of events) {
      const key = event.actor.id;
      const existing = actorCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        actorCounts.set(key, { actor: event.actor, count: 1 });
      }
    }
    const primaryActor = Array.from(actorCounts.values())
      .sort((a, b) => b.count - a.count)[0]?.actor;

    // Find primary target
    const targetCounts = new Map<string, { target: NormalizedEvent['target']; count: number }>();
    for (const event of events) {
      const key = event.target.id;
      const existing = targetCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        targetCounts.set(key, { target: event.target, count: 1 });
      }
    }
    const primaryTarget = Array.from(targetCounts.values())
      .sort((a, b) => b.count - a.count)[0]?.target;

    return {
      id: generateId(),
      type,
      start_time: sortedEvents[0].time,
      end_time: sortedEvents[sortedEvents.length - 1].time,
      primary_actor: primaryActor,
      primary_target: primaryTarget,
      events: sortedEvents.map(e => e.id),
      graph,
    };
  }

  /**
   * Build causal graph from events
   */
  private buildCausalGraph(events: NormalizedEvent[]): EpisodeGraph {
    const nodes = events.map(e => e.id);
    const edges: EpisodeGraph['edges'] = [];

    // Build edges based on correlation and temporal order
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      
      // Find events that this event might have caused
      for (let j = i + 1; j < events.length; j++) {
        const laterEvent = events[j];
        const relationship = this.inferRelationship(event, laterEvent);
        
        if (relationship) {
          edges.push({
            from: event.id,
            to: laterEvent.id,
            type: relationship,
          });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Infer relationship between two events
   */
  private inferRelationship(
    earlier: NormalizedEvent,
    later: NormalizedEvent
  ): EpisodeGraph['edges'][0]['type'] | null {
    // PR merge causes deployment
    if (earlier.kind === 'PR_MERGED' && later.kind === 'DEPLOYMENT') {
      if (earlier.correlation?.commit_sha === later.correlation?.commit_sha) {
        return 'CAUSES';
      }
    }

    // Deployment triggers traces
    if (earlier.kind === 'DEPLOYMENT' && later.kind === 'TRACE') {
      if (earlier.correlation?.deployment_id === later.correlation?.deployment_id) {
        return 'TRIGGERS';
      }
    }

    // Feature flag change causes traces
    if (earlier.kind === 'FEATURE_FLAG' && later.kind === 'TRACE') {
      return 'TRIGGERS';
    }

    // PR events follow each other
    if (earlier.kind.startsWith('PR_') && later.kind.startsWith('PR_')) {
      if (earlier.correlation?.pr_number === later.correlation?.pr_number) {
        return 'FOLLOWS';
      }
    }

    // Same trace ID means related
    if (earlier.correlation?.trace_id && 
        earlier.correlation.trace_id === later.correlation?.trace_id) {
      return 'RELATES_TO';
    }

    // Same deployment ID
    if (earlier.correlation?.deployment_id &&
        earlier.correlation.deployment_id === later.correlation?.deployment_id) {
      return 'RELATES_TO';
    }

    // Close temporal proximity (within 5 minutes) and same target
    const timeDiff = new Date(later.time).getTime() - new Date(earlier.time).getTime();
    if (timeDiff < 5 * 60 * 1000 && earlier.target.id === later.target.id) {
      return 'FOLLOWS';
    }

    return null;
  }
}

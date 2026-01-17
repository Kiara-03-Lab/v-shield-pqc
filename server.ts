import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { NormalizedEventInputSchema, NormalizedEventSchema } from '../types/index.js';
import { adapterRegistry } from '../adapters/index.js';
import { storage, type EventQuery, type EpisodeQuery } from '../storage/index.js';
import { CorrelationEngine } from '../engine/correlation.js';
import { NarrativeEngine } from '../engine/narrative.js';
import { generateId, hashPayload, redactSensitiveData } from '../utils/index.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Initialize engines
const correlationEngine = new CorrelationEngine(storage);
const narrativeEngine = new NarrativeEngine(storage);

// ============================================
// Health Check
// ============================================
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// Event Ingestion
// ============================================

// Ingest normalized events directly
app.post('/ingest/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    
    // Handle single event or array
    const rawEvents = Array.isArray(body) ? body : [body];
    const events = [];

    for (const rawEvent of rawEvents) {
      // Validate input (without id)
      const parsed = NormalizedEventInputSchema.safeParse(rawEvent);
      if (!parsed.success) {
        res.status(400).json({ 
          error: 'Invalid event format', 
          details: parsed.error.issues 
        });
        return;
      }

      // Generate ID and add to event
      const event = {
        ...parsed.data,
        id: generateId(),
      };

      // Store raw evidence
      if (event.evidence) {
        await storage.saveRawBlob(event.evidence.raw_ref, redactSensitiveData(rawEvent));
      }

      events.push(event);
    }

    // Save events
    await storage.saveEvents(events);

    // Auto-correlate and create episodes
    const episodes = await correlationEngine.correlate(events);

    // Generate narratives for new episodes
    const narratives = [];
    for (const episode of episodes) {
      const narrative = await narrativeEngine.generateNarrative(episode);
      narratives.push(narrative);
    }

    res.status(201).json({
      ingested: events.length,
      events: events.map(e => e.id),
      episodes: episodes.map(e => e.id),
      narratives: narratives.map(n => n.id),
    });
  } catch (error) {
    next(error);
  }
});

// Ingest via adapter webhook
app.post('/ingest/webhook/:adapter', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adapterName = req.params.adapter;
    const adapter = adapterRegistry.get(adapterName);

    if (!adapter) {
      res.status(404).json({ error: `Adapter '${adapterName}' not found` });
      return;
    }

    // Get headers as record
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    // Normalize via adapter
    const events = adapter.handleWebhook 
      ? await adapter.handleWebhook(req.body, headers)
      : adapter.normalize(req.body);

    if (events.length === 0) {
      res.status(200).json({ message: 'No events extracted from payload' });
      return;
    }

    // Save events
    await storage.saveEvents(events);

    // Auto-correlate
    const episodes = await correlationEngine.correlate(events);

    // Generate narratives
    for (const episode of episodes) {
      await narrativeEngine.generateNarrative(episode);
    }

    res.status(201).json({
      ingested: events.length,
      events: events.map(e => e.id),
      episodes: episodes.map(e => e.id),
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// Query Events
// ============================================
app.get('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query: EventQuery = {
      startTime: req.query.start_time as string | undefined,
      endTime: req.query.end_time as string | undefined,
      kind: req.query.kind ? (req.query.kind as string).split(',') : undefined,
      actorId: req.query.actor_id as string | undefined,
      targetId: req.query.target_id as string | undefined,
      correlationTraceId: req.query.trace_id as string | undefined,
      correlationCommitSha: req.query.commit_sha as string | undefined,
      correlationPrNumber: req.query.pr_number as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    };

    const events = await storage.queryEvents(query);
    res.json({ events, count: events.length });
  } catch (error) {
    next(error);
  }
});

app.get('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await storage.getEvent(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json(event);
  } catch (error) {
    next(error);
  }
});

// ============================================
// Episodes
// ============================================
app.get('/episodes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query: EpisodeQuery = {
      startTime: req.query.start_time as string | undefined,
      endTime: req.query.end_time as string | undefined,
      type: req.query.type ? (req.query.type as string).split(',') : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    };

    const episodes = await storage.queryEpisodes(query);
    res.json({ episodes, count: episodes.length });
  } catch (error) {
    next(error);
  }
});

app.get('/episodes/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const episode = await storage.getEpisode(req.params.id);
    if (!episode) {
      res.status(404).json({ error: 'Episode not found' });
      return;
    }

    const events = await storage.getEpisodeEvents(episode.id);
    res.json({ ...episode, _events: events });
  } catch (error) {
    next(error);
  }
});

app.get('/episodes/:id/narrative', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const episode = await storage.getEpisode(req.params.id);
    if (!episode) {
      res.status(404).json({ error: 'Episode not found' });
      return;
    }

    let narrative = await storage.getNarrative(episode.id);
    
    // Generate if not exists
    if (!narrative) {
      narrative = await narrativeEngine.generateNarrative(episode);
    }

    res.json(narrative);
  } catch (error) {
    next(error);
  }
});

// Recompute episodes
app.post('/episodes/recompute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start_time, end_time } = req.body;
    
    const episodes = await correlationEngine.recompute({
      startTime: start_time,
      endTime: end_time,
    });

    // Regenerate narratives
    for (const episode of episodes) {
      await narrativeEngine.generateNarrative(episode);
    }

    res.json({ 
      recomputed: episodes.length,
      episodes: episodes.map(e => e.id),
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// Evidence Export
// ============================================
app.get('/episodes/:id/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const episode = await storage.getEpisode(req.params.id);
    if (!episode) {
      res.status(404).json({ error: 'Episode not found' });
      return;
    }

    const events = await storage.getEpisodeEvents(episode.id);
    const narrative = await storage.getNarrative(episode.id);

    // Collect evidence blobs
    const evidence: Record<string, unknown> = {};
    for (const event of events) {
      if (event.evidence?.raw_ref) {
        const blob = await storage.getRawBlob(event.evidence.raw_ref);
        if (blob) {
          evidence[event.evidence.raw_ref] = blob;
        }
      }
    }

    res.json({
      episode,
      narrative,
      events,
      evidence,
      exported_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// Adapters Info
// ============================================
app.get('/adapters', (_req: Request, res: Response) => {
  res.json({ adapters: adapterRegistry.list() });
});

// ============================================
// Stats
// ============================================
app.get('/stats', (_req: Request, res: Response) => {
  const stats = (storage as any).stats?.() || {};
  res.json({ ...stats, timestamp: new Date().toISOString() });
});

// ============================================
// Error Handler
// ============================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message,
  });
});

export { app };

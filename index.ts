import { app } from './api/server.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ███╗   ██╗ █████╗ ██████╗ ██████╗  █████╗ ████████╗    ║
║   ████╗  ██║██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝    ║
║   ██╔██╗ ██║███████║██████╔╝██████╔╝███████║   ██║       ║
║   ██║╚██╗██║██╔══██║██╔══██╗██╔══██╗██╔══██║   ██║       ║
║   ██║ ╚████║██║  ██║██║  ██║██║  ██║██║  ██║   ██║       ║
║   ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝       ║
║                                                           ║
║   Human-Readable Audit Trails for Complex Systems         ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

🚀 Narratrace server running on http://localhost:${PORT}

API Endpoints:
  POST /ingest/events           - Ingest normalized events
  POST /ingest/webhook/:adapter - Ingest via adapter webhook
  GET  /events                  - Query events
  GET  /events/:id              - Get event by ID
  GET  /episodes                - Query episodes
  GET  /episodes/:id            - Get episode with events
  GET  /episodes/:id/narrative  - Get human-readable narrative
  GET  /episodes/:id/evidence   - Export evidence bundle
  POST /episodes/recompute      - Recompute episode correlations
  GET  /adapters                - List available adapters
  GET  /stats                   - Get storage statistics
  GET  /healthz                 - Health check
  `);
});

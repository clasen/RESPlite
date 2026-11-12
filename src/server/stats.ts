/**
 * Server-wide runtime counters reported by INFO and MEMORY STATS.
 * Share one instance across every connection of a server.
 */

export function createServerStats({ clock = () => Date.now() }: { clock?: () => number } = {}) {
  return {
    startedAt: clock(),
    startupRss: process.memoryUsage().rss,
    connectedClients: 0,
    totalConnectionsReceived: 0,
    totalCommandsProcessed: 0,
    clock,
  };
}

export type ServerStats = ReturnType<typeof createServerStats>;

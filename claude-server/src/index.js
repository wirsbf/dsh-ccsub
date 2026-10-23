#!/usr/bin/env node
/**
 * Entry point: wire configuration, transport, grant store, and HTTP server.
 *
 * Startup fails loudly on a missing client bearer or an unusable proxy, because
 * a server that came up in a half-configured state would either be reachable
 * without authentication or quietly egress from the wrong address.
 *
 * @module claude-server
 */

import { loadConfig } from './config.js';
import { GrantStore } from './grant.js';
import { createServer } from './server.js';
import { Transport } from './transport.js';

/** A minimal leveled logger; the container's stdout is the sink. */
function createLogger(level) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = order[level] ?? order.info;
  const write = (name, stream) => (message, ...rest) => {
    if ((order[name] ?? 9) > threshold) return;
    let index = 0;
    const text = String(message).replace(/%[sd]/g, () => String(rest[index++]));
    stream.write(`[claude-server] ${name} ${text}\n`);
  };
  return {
    error: write('error', process.stderr),
    warn: write('warn', process.stderr),
    info: write('info', process.stdout),
    debug: write('debug', process.stdout),
  };
}

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  const transport = new Transport({ mode: config.mode, proxyUrl: config.proxyUrl });
  const grants = new GrantStore({
    path: config.grantPath,
    refreshSkewMs: config.refreshSkewMs,
    logger,
  });

  const { server, dispose } = createServer({ config, transport, grants, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info(
    'listening on http://%s:%d (mode=%s, grant=%s)',
    config.listenHost,
    config.listenPort,
    config.mode,
    config.grantPath,
  );

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('received %s, shutting down', signal);
    try {
      await dispose();
      await transport.dispose();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(`[claude-server] fatal ${String(error?.message ?? error)}\n`);
  process.exit(1);
});

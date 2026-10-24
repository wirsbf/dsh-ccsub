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

import { AccountDirectory } from './accounts.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { Transport } from './transport.js';
import { UserDirectory } from './users.js';

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
  // One directory owning every account's grant. The default account resolves to
  // `GRANT_PATH`, so an upgraded deployment keeps serving its existing grant
  // without a migration write.
  const accounts = new AccountDirectory({
    path: config.accountsPath,
    grantsDir: config.grantsDir,
    legacyGrantPath: config.grantPath,
    refreshSkewMs: config.refreshSkewMs,
    logger,
  });
  // Constructing the directory touches no disk: the file is created on the first
  // user. A deployment whose volume is missing or read-only therefore still
  // starts and still serves the relay through the environment bearer; only
  // creating a user fails, which is the failure worth having in that situation.
  const users = new UserDirectory({ path: config.usersPath, logger });

  const { server, dispose } = createServer({ config, transport, accounts, users, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info(
    'listening on http://%s:%d (mode=%s, grant=%s, accounts=%s)',
    config.listenHost,
    config.listenPort,
    config.mode,
    config.grantPath,
    config.accountsPath,
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

// Note: logger.js lit process.env directement (chargé avant env.js — pas de dépendance circulaire)
/**
 * ═══════════════════════════════════════════════════════════════
 *  PILIER 3 — LE TÉMOIN WINSTON  (utils/logger.js)
 *  Logs professionnels : console colorée + fichiers rotatifs
 * ═══════════════════════════════════════════════════════════════
 */

const winston = require('winston');
const path    = require('path');

const { combine, timestamp, colorize, printf, json, errors } = winston.format;

// ── Dossier de logs ─────────────────────────────────────────────
const LOG_DIR   = path.join(__dirname, '../logs');
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// ── Format console élégant ──────────────────────────────────────
const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const stackStr = stack ? `\n${stack}` : '';
  return `${ts} [${level}] ${message}${metaStr}${stackStr}`;
});

// ── Transports ──────────────────────────────────────────────────
const transports = [
  // Console (toujours)
  new winston.transports.Console({
    level  : LOG_LEVEL,
    format : combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      consoleFormat,
    ),
  }),
];

// Fichiers uniquement si pas dans un contexte Replit / Cloud sans FS persistant
if (process.env.NODE_ENV !== 'test') {
  try {
    const fs = require('fs');
    fs.mkdirSync(LOG_DIR, { recursive: true });

    // Tous les logs (JSON compact pour parsing)
    transports.push(new winston.transports.File({
      filename : path.join(LOG_DIR, 'app.log'),
      level    : 'debug',
      maxsize  : 5 * 1024 * 1024,  // 5 MB
      maxFiles : 3,
      format   : combine(timestamp(), errors({ stack: true }), json()),
    }));

    // Erreurs uniquement
    transports.push(new winston.transports.File({
      filename : path.join(LOG_DIR, 'error.log'),
      level    : 'error',
      maxsize  : 2 * 1024 * 1024,
      maxFiles : 2,
      format   : combine(timestamp(), errors({ stack: true }), json()),
    }));
  } catch {
    // Système de fichiers en lecture seule — logs console seulement
  }
}

// ── Instance principale ─────────────────────────────────────────
const logger = winston.createLogger({
  level      : LOG_LEVEL,
  transports,
  exitOnError: false,
});

// ── Helpers sémantiques ─────────────────────────────────────────
logger.success = (msg, meta) => logger.info(`✅ ${msg}`, meta);
logger.step    = (n, total, msg) => logger.info(`[${n}/${total}] ${msg}`);
logger.sep     = () => logger.info('─'.repeat(50));

module.exports = logger;

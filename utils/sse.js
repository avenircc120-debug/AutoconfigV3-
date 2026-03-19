/**
 * ═══════════════════════════════════════════════════════════════
 *  SERVER-SENT EVENTS  (utils/sse.js)
 *  Diffusion temps réel de la progression 0% → 100%
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require('./logger');

/** Map des connexions SSE actives : jobId → res */
const clients = new Map();

/**
 * Middleware Express qui upgrades une connexion GET en flux SSE.
 * Le client reçoit les événements via EventSource JS.
 *
 * Usage dans router: router.get('/events/:jobId', sseMiddleware)
 */
function sseMiddleware(req, res) {
  const { jobId } = req.params;

  // Headers SSE obligatoires
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx : désactiver le buffering
  res.flushHeaders();

  // Enregistrer le client
  clients.set(jobId, res);
  logger.debug(`[SSE] Client connecté pour job "${jobId}" (total: ${clients.size})`);

  // Heartbeat toutes les 20s (évite timeout proxy)
  const heartbeat = setInterval(() => {
    if (clients.has(jobId)) res.write(': heartbeat\n\n');
  }, 20_000);

  // Nettoyage si le client ferme l'onglet
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(jobId);
    logger.debug(`[SSE] Client déconnecté: ${jobId}`);
  });
}

/**
 * Envoyer un événement SSE à un job spécifique.
 *
 * @param {string} jobId
 * @param {object} payload
 * @param {string} payload.type     - 'progress' | 'log' | 'done' | 'error'
 * @param {number} [payload.pct]    - Pourcentage 0-100
 * @param {string} [payload.msg]    - Message lisible
 * @param {any}    [payload.data]   - Données supplémentaires
 */
function emit(jobId, payload) {
  const res = clients.get(jobId);
  if (!res) return; // Client déconnecté ou jobId inconnu

  const event = payload.type || 'message';
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Diffuse toutes les étapes d'un pipeline avec progression automatique.
 *
 * @param {string}   jobId
 * @param {Array}    steps    - [{ label, fn }]  fn est async
 */
async function runPipeline(jobId, steps) {
  const total = steps.length;

  emit(jobId, { type: 'progress', pct: 0, msg: 'Démarrage…' });

  for (let i = 0; i < total; i++) {
    const step = steps[i];
    const pct  = Math.round(((i) / total) * 100);

    emit(jobId, { type: 'progress', pct, msg: step.label, step: i + 1, total });
    emit(jobId, { type: 'log', msg: `[${i + 1}/${total}] ${step.label}` });

    try {
      const result = await step.fn();
      const donePct = Math.round(((i + 1) / total) * 100);
      emit(jobId, { type: 'progress', pct: donePct, msg: `✓ ${step.label}` });
      if (result) emit(jobId, { type: 'log', msg: `↳ ${JSON.stringify(result)}` });

    } catch (err) {
      emit(jobId, { type: 'error', pct, msg: `✗ ${err.message}`, step: i + 1 });
      throw err;
    }
  }

  emit(jobId, { type: 'done', pct: 100, msg: 'Déploiement terminé avec succès !' });
  clients.delete(jobId); // Fermer le flux
}

module.exports = { sseMiddleware, emit, runPipeline };

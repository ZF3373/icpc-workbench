import { Router } from 'express';
import { asyncHandler } from '../asyncHandler.ts';
import type { WebDavSync } from '../data-sync/service.ts';
import { syncErrorMessage } from '../data-sync/service.ts';

const DIGEST = /^[a-f0-9]{64}$/;

export function webDavSyncRoutes(sync: WebDavSync): Router {
  const r = Router();
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  r.get('/', (_req, res) => res.json(sync.status()));
  r.put('/', (req, res) => {
    try {
      res.json(sync.configure(req.body));
    } catch (error) {
      res.status(400).json({ error: syncErrorMessage(error) });
    }
  });
  r.post('/test', asyncHandler(async (req, res) => {
    try {
      await sync.testConnection(req.body);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: syncErrorMessage(error) });
    }
  }));
  r.post('/run', asyncHandler(async (_req, res) => {
    res.json(await sync.run());
  }));
  r.post('/resolve', asyncHandler(async (req, res) => {
    const { keep, local, remote } = req.body ?? {};
    if ((keep !== 'local' && keep !== 'remote') || typeof local !== 'string' || !DIGEST.test(local) ||
      (remote === null ? keep !== 'local' : typeof remote !== 'string' || !DIGEST.test(remote))) {
      res.status(400).json({ error: '请选择要保留的同步版本' });
      return;
    }
    res.json(await sync.run({ keep, local, remote }));
  }));
  return r;
}

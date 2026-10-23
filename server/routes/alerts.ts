/**
 * Alerts — channels (webhook, ntfy, Discord, Slack), their events, and the
 * alert options. Admin only: a channel URL is a credential.
 *
 * URLs and secrets are write-only from the API's point of view: responses
 * carry a masked preview of the URL and whether a secret is set, never the
 * values, and an update that leaves them out keeps what is stored.
 *
 * See server/lib/alerts for the events and how they are sent.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  createAlertChannel,
  deleteAlertChannel,
  getAlertChannel,
  getAlertConfig,
  listAlertChannels,
  setAlertConfig,
  updateAlertChannel,
} from '../lib/alerts/store.js';
import { sendToChannel } from '../lib/alerts/delivery.js';
import { lastClearNightCheck, runClearNightCheck } from '../lib/alerts/clearNight.js';
import { ALERT_CHANNEL_KINDS, ALERT_EVENTS, ALERT_LANGUAGES, type AlertChannel } from '../lib/alerts/types.js';

const router = Router();
router.use(requireAdmin);

const HttpUrl = z.string().trim().max(2000).refine(v => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Enter an http:// or https:// URL');

const ChannelBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ALERT_CHANNEL_KINDS),
  url: HttpUrl,
  secret: z.string().max(200).nullable().optional(),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length),
  enabled: z.boolean().optional(),
});

const ChannelPatch = ChannelBody.partial();

const ConfigBody = z.object({
  language: z.enum(ALERT_LANGUAGES).optional(),
  clearNight: z.object({
    checkTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    minClearHours: z.number().min(0.5).max(14).optional(),
    maxCloudCover: z.number().int().min(0).max(100).optional(),
  }).optional(),
});

/** "https://discord.com/…a1b2": enough to recognise a channel, not to use it. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = `${u.pathname}${u.search}`;
    const tail = rest.length > 4 ? rest.slice(-4) : '';
    return `${u.protocol}//${u.host}${rest.length > 1 ? `/…${tail}` : ''}`;
  } catch {
    return '';
  }
}

function present(c: AlertChannel) {
  const { url, secret, ...rest } = c;
  return { ...rest, urlPreview: maskUrl(url), hasSecret: secret !== null };
}

function invalid(res: Response, error: z.ZodError): void {
  res.apiError(422, 'VALIDATION_ERROR', error.issues[0]?.message ?? 'Invalid request body');
}

router.get('/', (_req: Request, res: Response) => {
  res.apiSuccess({
    channels: listAlertChannels().map(present),
    config: getAlertConfig(),
    events: ALERT_EVENTS,
    lastClearNightCheck: lastClearNightCheck(),
  });
});

router.post('/channels', (req: Request, res: Response) => {
  const parsed = ChannelBody.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  res.status(201);
  res.apiSuccess(present(createAlertChannel(parsed.data)));
});

router.put('/channels/:id', (req: Request, res: Response) => {
  const parsed = ChannelPatch.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const updated = updateAlertChannel(String(req.params.id), parsed.data);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  res.apiSuccess(present(updated));
});

router.delete('/channels/:id', (req: Request, res: Response) => {
  if (!deleteAlertChannel(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// Send a test alert to one channel, whatever its events, and say how it went.
router.post('/channels/:id/test', async (req: Request, res: Response) => {
  const channel = getAlertChannel(String(req.params.id));
  if (!channel) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  const result = await sendToChannel(channel, { type: 'test', occurredAt: new Date().toISOString(), data: {} });
  res.apiSuccess({ ...result, channel: present(getAlertChannel(channel.id) ?? channel) });
});

router.put('/config', (req: Request, res: Response) => {
  const parsed = ConfigBody.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  res.apiSuccess(setAlertConfig(parsed.data));
});

// What tonight's clear-night check would say right now, without sending it.
router.post('/clear-night/preview', async (_req: Request, res: Response) => {
  res.apiSuccess(await runClearNightCheck(new Date(), false));
});

export { router as alertsRouter };

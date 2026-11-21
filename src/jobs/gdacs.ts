import { createHash } from 'node:crypto';

import type { Db } from '../db/pool.js';

/**
 * GDACS publishes an RSS feed of ongoing disasters. We deliberately parse it
 * with the standard library: the job needs a handful of text fields, and adding
 * an XML parser would mean a new dependency (and a new thing for the security
 * review to vet). The feed is a trusted, fixed shape; if a tag is missing we
 * simply store what we do have rather than failing the whole poll.
 */

const EVENT_TYPES: Record<string, string> = {
  EQ: 'earthquake',
  TC: 'cyclone',
  FL: 'flood',
  DR: 'drought',
  WF: 'wildfire',
  TS: 'tsunami',
  VO: 'volcano',
  LS: 'landslide',
};

export interface GdacsAlert {
  id: string;
  eventType: string;
  severity: 'orange' | 'red';
  title: string;
  location: string | null;
  country: string | null;
  url: string | null;
  description: string | null;
  publishedAt: Date | null;
  raw: Record<string, string>;
}

/** Matches `<name>value</name>`, with or without an XML namespace prefix. */
function tag(block: string, name: string): string | null {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`,
    'i',
  );
  const value = re.exec(block)?.[1];
  if (!value) return null;
  return decodeEntities(value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()) || null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function text(value: string | null, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

/** Extracts only new orange and red alerts from a recorded or live GDACS feed. */
export function parseGdacsFeed(xml: string): GdacsAlert[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const alerts: GdacsAlert[] = [];

  for (const item of items) {
    const level = tag(item, 'alertlevel')?.toLowerCase() ?? '';
    if (level !== 'orange' && level !== 'red') continue; // green alerts are noise for organisers

    const code = tag(item, 'eventtype') ?? '';
    const title = tag(item, 'title') ?? 'Disaster alert';
    const country = text(tag(item, 'country'), 200);
    const link = tag(item, 'link');
    const guid = tag(item, 'guid');
    const published = tag(item, 'pubDate');
    const parsedDate = published ? new Date(published) : null;

    const raw: Record<string, string> = {};
    for (const match of item.matchAll(/<([\w.-]+):([\w.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1:\2>/g)) {
      const key = match[2];
      const value = match[3];
      if (key && value) raw[key] = decodeEntities(value.trim()).slice(0, 500);
    }

    alerts.push({
      // The guid is stable across polls; fall back to a hash of the link when
      // the feed omits it, so repeated polls never create duplicate rows.
      id:
        guid ??
        createHash('sha256')
          .update(`${code}:${link ?? title}`)
          .digest('hex'),
      eventType: (EVENT_TYPES[code.toUpperCase()] ?? code.toLowerCase()) || 'unknown',
      severity: level,
      title: title.slice(0, 500),
      location: text(tag(item, 'location'), 300) ?? country ?? text(title, 300),
      country,
      url: link ? link.slice(0, 2000) : null,
      description: text(tag(item, 'description'), 4000),
      publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      raw,
    });
  }
  return alerts;
}

/** Fetches one feed snapshot and stores new alerts. Returns how many were inserted. */
export async function pollGdacs(
  db: Db,
  feedUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchFn(feedUrl, {
    headers: { accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GDACS feed returned HTTP ${res.status}`);

  const alerts = parseGdacsFeed(await res.text());
  let inserted = 0;
  for (const alert of alerts) {
    const { rowCount } = await db.query(
      `INSERT INTO gdacs_alerts
         (id, event_type, severity, title, location, country, url, description, published_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        alert.id,
        alert.eventType,
        alert.severity,
        alert.title,
        alert.location,
        alert.country,
        alert.url,
        alert.description,
        alert.publishedAt,
        JSON.stringify(alert.raw),
      ],
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}

export interface JobLogger {
  info(msg: string, ...args: unknown[]): void;
  error(obj: unknown, msg: string): void;
}

/**
 * Starts the poller as an isolated job. Every failure is caught and logged, so
 * a slow or broken GDACS feed can never take the API or the indexer down.
 * The timer is returned so the caller can clear it on shutdown.
 */
export function startGdacsScheduler(
  db: Db,
  feedUrl: string,
  pollMs: number,
  log: JobLogger,
  fetchFn: typeof fetch = fetch,
): NodeJS.Timeout {
  const tick = async () => {
    try {
      const inserted = await pollGdacs(db, feedUrl, fetchFn);
      if (inserted) log.info(`stored ${inserted} new GDACS alert(s)`);
    } catch (err) {
      log.error({ err }, 'GDACS poll failed; will retry on the next tick');
    }
  };

  void tick();
  return setInterval(() => void tick(), pollMs);
}

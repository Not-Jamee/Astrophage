/**
 * /api/eonet – NASA EONET v3 natural-event proxy.
 * Returns volcanoes, wildfires and severe storms active in the last 30 days.
 * No API key required. Docs: https://eonet.gsfc.nasa.gov/docs/v3
 */
import { NextRequest, NextResponse } from 'next/server';

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';

const CATEGORY_TO_TYPE: Record<string, string> = {
  volcanoes:    'volcano',
  wildfires:    'wildfire',
  severeStorms: 'storm',
};

function toPoint(g: any): [number, number] | null {
  if (!g?.coordinates) return null;
  if (g.type === 'Point') return [Number(g.coordinates[0]), Number(g.coordinates[1])];
  if (g.type === 'Polygon') {
    const ring: number[][] = g.coordinates[0] ?? [];
    if (!ring.length) return null;
    const sum = ring.reduce((a: number[], c: number[]) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  return null;
}

export async function GET(req: NextRequest) {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);

  const sp = req.nextUrl.searchParams;
  const start = sp.get('start') ?? monthAgo.toISOString().slice(0, 10);
  const end   = sp.get('end')   ?? today.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    category: 'volcanoes,wildfires,severeStorms',
    status: 'all',
    start,
    end,
    limit: '500',
  });

  try {
    const res = await fetch(`${EONET_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 900 },
    });

    if (!res.ok) {
      return NextResponse.json({ features: [], error: `EONET returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    const startMs = new Date(`${start}T00:00:00Z`).getTime();
    const endMs   = new Date(`${end}T23:59:59Z`).getTime();
    const features: any[] = [];

    for (const ev of data.events ?? []) {
      const catId: string = ev.categories?.[0]?.id ?? '';
      const type = CATEGORY_TO_TYPE[catId];
      if (!type) continue;

      const geoms = (ev.geometry ?? [])
        .filter((g: any) => {
          const t = new Date(g.date).getTime();
          return t >= startMs && t <= endMs;
        })
        .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const g = geoms[geoms.length - 1] ?? ev.geometry?.[ev.geometry.length - 1];
      const pt = toPoint(g);
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;

      features.push({
        id: ev.id,
        type,
        title: ev.title ?? 'Natural event',
        category: catId,
        date: g?.date ?? null,
        closed: ev.closed ?? null,
        magnitude: g?.magnitudeValue ?? null,
        magnitudeUnit: g?.magnitudeUnit ?? null,
        link: ev.sources?.[0]?.url ?? ev.link ?? '',
        coordinates: pt,
      });
    }

    return NextResponse.json(
      { features },
      { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=300' } },
    );
  } catch (err) {
    console.error('[/api/eonet] fetch failed:', err);
    return NextResponse.json({ features: [], error: 'Failed to reach NASA EONET' }, { status: 502 });
  }
}

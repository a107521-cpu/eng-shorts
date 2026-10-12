/**
 * Eng Shorts 자막 서버 (Cloudflare Worker)
 *
 * 브라우저는 보안 규칙(CORS) 때문에 YouTube 자막을 직접 읽을 수 없어요.
 * 이 작은 서버가 대신 자막을 가져와서 앱에 넘겨줘요.
 *
 *   GET /ping                    → { ok: true }
 *   GET /subs?v=영상ID&tl=ko      → { ok, kind, cues:[{s,d,t}], ko:[{s,d,t}] | null }
 *   GET /shorts?ch=UC...          → { ok, ids:[...] }   채널의 최신 쇼츠 (RSS)
 *   GET /resolve?q=@핸들           → { ok, id, name }    @핸들 → 채널 ID
 *
 * 선택: Worker 설정 > Variables 에 ALLOW_ORIGIN 을 넣으면 그 주소에서만 쓸 수 있어요.
 *       예) https://a107521-cpu.github.io
 */

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// YouTube 앱 흉내를 내는 클라이언트들. 하나가 막히면 다음 것을 시도해요.
const CLIENTS = [
  {
    name: 'ANDROID', num: 3, version: '20.10.38',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    extra: { androidSdkVersion: 34, osName: 'Android', osVersion: '14' }
  },
  {
    name: 'IOS', num: 5, version: '20.10.4',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', num: 85, version: '2.0',
    ua: WEB_UA, extra: {}, embed: true
  }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return send({ ok: false, error: 'method' }, 405, headers);
    try {
      switch (url.pathname) {
        case '/':
        case '/ping': return send({ ok: true, service: 'eng-shorts-subs', ver: 1 }, 200, headers);
        case '/subs': return withCache(url, ctx, headers, 3 * 86400, () => getSubs(url));
        case '/shorts': return withCache(url, ctx, headers, 3 * 3600, () => getShorts(url));
        case '/resolve': return withCache(url, ctx, headers, 7 * 86400, () => resolveHandle(url));
        default: return send({ ok: false, error: 'not_found' }, 404, headers);
      }
    } catch (e) {
      return send({ ok: false, error: 'server', detail: String((e && e.message) || e) }, 500, headers);
    }
  }
};

/* ---------- plumbing ---------- */
function corsHeaders(request, env) {
  const allow = (env && env.ALLOW_ORIGIN) || '*';
  const origin = request.headers.get('origin') || '';
  return {
    'access-control-allow-origin': allow === '*' ? '*' : (origin === allow ? origin : allow),
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
}
function send(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}
async function withCache(url, ctx, headers, ttl, make) {
  const key = new Request(url.toString(), { method: 'GET' });
  let cache = null;
  try { cache = caches.default; } catch {}
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return send(await hit.json(), 200, { ...headers, 'x-cache': 'hit' });
    } catch {}
  }
  const data = await make();
  if (data.ok && cache) {
    const res = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } });
    try { ctx.waitUntil(cache.put(key, res)); } catch {}
  }
  const status = data.ok ? 200 : (data.status || 502);
  delete data.status;
  return send(data, status, headers);
}

/* ---------- subtitles ---------- */
async function getSubs(url) {
  const v = url.searchParams.get('v') || '';
  if (!/^[\w-]{11}$/.test(v)) return { ok: false, status: 400, error: 'bad_id' };
  const tl = (url.searchParams.get('tl') || '').replace(/[^a-zA-Z-]/g, '').slice(0, 8);
  const tried = [];
  let sawNoCaptions = false;

  for (const c of CLIENTS) {
    let tracks;
    try { tracks = await playerTracks(v, c); }
    catch (e) { tried.push(`${c.name}:${e.message}`); continue; }
    if (!tracks.length) { sawNoCaptions = true; tried.push(`${c.name}:no_tracks`); continue; }
    const result = await fromTracks(v, tracks, tl, c.name);
    if (result) return result;
    tried.push(`${c.name}:empty_track`);
  }

  // 마지막 수단: 일반 시청 페이지에서 자막 목록 꺼내기
  try {
    const tracks = await watchPageTracks(v);
    if (tracks && tracks.length) {
      const result = await fromTracks(v, tracks, tl, 'WEB_PAGE');
      if (result) return result;
      tried.push('WEB_PAGE:empty_track');
    } else if (tracks) { sawNoCaptions = true; tried.push('WEB_PAGE:no_tracks'); }
  } catch (e) { tried.push(`WEB_PAGE:${e.message}`); }

  if (sawNoCaptions) return { ok: false, status: 404, error: 'no_captions', tried };
  return { ok: false, status: 502, error: 'blocked', tried };
}

async function fromTracks(v, tracks, tl, client) {
  const tr = pickTrack(tracks);
  if (!tr) return { ok: false, status: 404, error: 'no_english' };
  const cues = await fetchTrack(tr.baseUrl);
  if (!cues.length) return null;
  let ko = null;
  if (tl) {
    try { const k = await fetchTrack(tr.baseUrl.replace(/&tlang=[^&]*/g, '') + '&tlang=' + tl); if (k.length) ko = k; } catch {}
  }
  return { ok: true, v, client, kind: tr.kind === 'asr' ? 'asr' : 'manual', lang: tr.languageCode, cues, ko };
}

async function playerTracks(v, c) {
  const body = {
    context: { client: { clientName: c.name, clientVersion: c.version, hl: 'en', gl: 'US', ...c.extra } },
    videoId: v, contentCheckOk: true, racyCheckOk: true
  };
  if (c.embed) body.context.thirdParty = { embedUrl: 'https://www.youtube.com/' };
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': c.ua,
      'x-youtube-client-name': String(c.num),
      'x-youtube-client-version': c.version,
      origin: 'https://www.youtube.com',
      'accept-language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('http_' + r.status);
  const j = await r.json();
  const tracks = j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (tracks && tracks.length) return tracks;
  const st = j && j.playabilityStatus && j.playabilityStatus.status;
  if (st && st !== 'OK') throw new Error(st);
  return [];
}

async function watchPageTracks(v) {
  const r = await fetch(`https://www.youtube.com/watch?v=${v}&hl=en&has_verified=1&bpctr=9999999999`, {
    headers: { 'user-agent': WEB_UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+cb; SOCS=CAI' }
  });
  if (!r.ok) throw new Error('http_' + r.status);
  const html = await r.text();
  if (/"playabilityStatus":\{"status":"LOGIN_REQUIRED"/.test(html)) throw new Error('LOGIN_REQUIRED');
  const at = html.indexOf('"captionTracks":');
  if (at < 0) return /"playabilityStatus":\{"status":"OK"/.test(html) ? [] : null;
  const arr = sliceJsonArray(html, at + '"captionTracks":'.length);
  return arr ? JSON.parse(arr) : null;
}

function sliceJsonArray(s, i) {
  if (s[i] !== '[') return null;
  let depth = 0, inStr = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (inStr) { if (ch === '\\') k++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return s.slice(i, k + 1); }
  }
  return null;
}

function pickTrack(tracks) {
  const lang = t => (t.languageCode || '').toLowerCase();
  const en = tracks.filter(t => lang(t) === 'en' || lang(t).startsWith('en-'));
  return en.find(t => t.kind !== 'asr' && lang(t) === 'en')
    || en.find(t => t.kind !== 'asr')
    || en.find(t => t.kind === 'asr')
    || null;
}

async function fetchTrack(baseUrl) {
  const base = baseUrl.replace(/&fmt=[^&]*/g, '');
  const get = async u => {
    const r = await fetch(u, { headers: { 'user-agent': WEB_UA, 'accept-language': 'en-US,en;q=0.9' } });
    return r.ok ? r.text() : '';
  };
  try {
    const t = await get(base + '&fmt=json3');
    if (t && t.trim().startsWith('{')) {
      const cues = parseJson3(JSON.parse(t));
      if (cues.length) return cues;
    }
  } catch {}
  const x = await get(base);
  return x ? parseXml(x) : [];
}

function parseJson3(j) {
  const out = [];
  for (const e of j.events || []) {
    if (!e.segs) continue;
    const t = clean(e.segs.map(s => s.utf8 || '').join(''));
    if (!t) continue;
    out.push({ s: round((e.tStartMs || 0) / 1000), d: round((e.dDurationMs || 0) / 1000), t });
  }
  return out;
}

function parseXml(x) {
  const out = [];
  let m;
  const reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;           // srv3
  while ((m = reP.exec(x))) {
    const t = clean(m[2]);
    const st = attr(m[1], 't'), du = attr(m[1], 'd');
    if (t && st != null) out.push({ s: round(+st / 1000), d: round(+(du || 0) / 1000), t });
  }
  if (out.length) return out;
  const reT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;     // srv1
  while ((m = reT.exec(x))) {
    const t = clean(m[2]);
    const st = attr(m[1], 'start'), du = attr(m[1], 'dur');
    if (t && st != null) out.push({ s: round(+st), d: round(+(du || 0)), t });
  }
  return out;
}

const attr = (s, name) => { const m = s.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };
const round = n => Math.round(n * 1000) / 1000;
function clean(s) {
  let t = s.replace(/<[^>]+>/g, '');
  t = decode(t);
  if (/&(#?\w+);/.test(t)) t = decode(t);
  return t.replace(/\s+/g, ' ').trim();
}
function decode(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return all;
  });
}

/* ---------- channel shorts (RSS) ---------- */
async function getShorts(url) {
  const ch = url.searchParams.get('ch') || '';
  if (!/^UC[\w-]{22}$/.test(ch)) return { ok: false, status: 400, error: 'bad_channel' };
  const read = async u => { const r = await fetch(u, { headers: { 'user-agent': WEB_UA } }); return r.ok ? r.text() : ''; };
  let x = await read(`https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${ch.slice(2)}`);
  let ids = [...x.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map(m => m[1]);
  if (!ids.length) {
    x = await read(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`);
    ids = [...x.matchAll(/<entry>[\s\S]*?<\/entry>/g)]
      .map(m => m[0])
      .filter(e => /youtube\.com\/shorts\//.test(e))
      .map(e => (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1])
      .filter(Boolean);
  }
  return ids.length ? { ok: true, ids } : { ok: false, status: 404, error: 'no_shorts' };
}

/* ---------- @handle → channel id ---------- */
async function resolveHandle(url) {
  const q = (url.searchParams.get('q') || '').trim();
  const h = (q.match(/@[\w.\-]+/) || [])[0];
  if (!h) return { ok: false, status: 400, error: 'bad_handle' };
  const r = await fetch(`https://www.youtube.com/${h}`, { headers: { 'user-agent': WEB_UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+cb; SOCS=CAI' } });
  if (!r.ok) return { ok: false, status: 404, error: 'not_found' };
  const html = await r.text();
  const id = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/) || html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1];
  const name = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1];
  return id ? { ok: true, id, name: name ? decode(name) : h } : { ok: false, status: 404, error: 'not_found' };
}

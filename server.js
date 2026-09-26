const http = require("http");

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://aino-spatial-workspace.tassilo.chatgpt.site";

const buckets = new Map();

function cors(origin) {
  const ok = !origin || origin === ALLOWED_ORIGIN;
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok && origin ? origin : ALLOWED_ORIGIN,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function ipOf(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .toString()
    .split(",")[0]
    .trim();
}

function allowedRate(req) {
  const ip = ipOf(req);
  const now = Date.now();
  const item = buckets.get(ip) || { start: now, count: 0 };
  if (now - item.start > 60000) {
    item.start = now;
    item.count = 0;
  }
  item.count++;
  buckets.set(ip, item);
  return item.count <= 20;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function stripFences(value) {
  return String(value || "")
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "")
    .trim();
}

async function research(body) {
  const query = String(body.query || "").trim().slice(0, 2000);
  if (!query) throw new Error("Missing query");

  const viewport = body.viewport || body.bbox || null;
  const center = body.center || null;

  const instructions = `You are AINO's spatial-data research agent. Turn natural-language map questions into machine-usable geospatial data sources.

Search the web and public spatial-data catalogues. Prefer:
1. Official city, municipality, state, or federal data portals and services.
2. Official ArcGIS REST FeatureServer/MapServer, OGC API Features, WFS, WMS, GeoJSON or JSON downloads.
3. Reputable public catalogues that point to the authoritative publisher.

Do not stop at a descriptive webpage when a machine-readable service or direct download exists.
For ArcGIS layers, prefer a FeatureServer layer URL and mention that it can be queried with f=geojson.
For WFS, identify the service URL and typeName when possible.
For direct GeoJSON, return the direct URL.
Prefer current sources and mention dates when available.

Return JSON only with this shape:
{
  "summary": "short answer",
  "datasets": [{
    "title": "dataset title",
    "publisher": "publisher",
    "sourceUrl": "authoritative metadata/source page",
    "directDataUrl": "direct machine-readable endpoint if found, otherwise null",
    "serviceType": "geojson|arcgis-feature|wfs|wms|ogc-api|download|unknown",
    "format": "GeoJSON|JSON|Shapefile|...",
    "layerName": "layer/typeName or null",
    "crs": "EPSG code/name or null",
    "geometryType": "Polygon|Point|LineString|unknown",
    "license": "license or null",
    "confidence": 0.0,
    "why": "why this source is appropriate"
  }],
  "mapAction": {
    "type": "add_geojson|add_arcgis_feature_layer|add_wfs|none",
    "url": "best machine-readable URL or null",
    "layerName": "optional layer name or null",
    "query": "optional ArcGIS/WFS query parameters or null"
  }
}

Rank the authoritative, directly mappable source first. confidence must be 0..1.`;

  const prompt = `${instructions}

Map question: ${query}
Current map viewport: ${viewport ? JSON.stringify(viewport) : "not supplied"}
Current map center: ${center ? JSON.stringify(center) : "not supplied"}

Find the best spatial dataset and a directly usable map endpoint.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 4096
      }
    })
  });

  const raw = await resp.json();
  if (!resp.ok) {
    throw new Error(raw?.error?.message || `Gemini HTTP ${resp.status}`);
  }

  const text = raw?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("") || "";

  let result;
  try {
    result = JSON.parse(stripFences(text));
  } catch {
    result = {
      summary: text || "Gemini returned no parseable result",
      datasets: [],
      mapAction: { type: "none", url: null, layerName: null, query: null }
    };
  }

  result.meta = {
    model: MODEL,
    grounding: Boolean(raw?.candidates?.[0]?.groundingMetadata)
  };

  return result;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const c = cors(origin);

  if (req.method === "OPTIONS") {
    if (!c.ok) return send(res, 403, { error: "Origin not allowed" }, c.headers);
    res.writeHead(204, c.headers);
    return res.end();
  }

  if (!c.ok) return send(res, 403, { error: "Origin not allowed" }, c.headers);
  if (!allowedRate(req)) return send(res, 429, { error: "Rate limit exceeded" }, c.headers);

  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      return send(res, 200, {
        ok: true,
        service: "aino-spatial-agent",
        model: MODEL,
        keyConfigured: Boolean(GEMINI_API_KEY)
      }, c.headers);
    }

    if (req.method === "POST" && req.url === "/research") {
      if (!GEMINI_API_KEY) {
        return send(res, 503, { error: "Gemini key not configured" }, c.headers);
      }
      const body = await readJson(req);
      const result = await research(body);
      return send(res, 200, result, c.headers);
    }

    return send(res, 404, { error: "Not found" }, c.headers);
  } catch (err) {
    console.error("request_error", err?.message || err);
    return send(res, 500, { error: err?.message || "Internal error" }, c.headers);
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`AINO agent listening on ${PORT}`);

  if (process.env.RUN_SMOKE_TEST === "1" && GEMINI_API_KEY) {
    try {
      const result = await research({
        query: "Find the official Cologne (Köln) Stadtbezirke district boundaries and return the best directly mappable authoritative dataset."
      });
      console.log("SMOKE_TEST_RESULT", JSON.stringify({
        summary: result.summary,
        firstDataset: result.datasets?.[0] || null,
        mapAction: result.mapAction || null,
        meta: result.meta || null
      }));
    } catch (err) {
      console.error("SMOKE_TEST_ERROR", err?.message || err);
    }
  }
});

'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html', 'text/plain', 'application/xhtml+xml', 'application/json',
]);

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value * 256) + part, 0) >>> 0;
}

function inV4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, prefix]) => inV4Range(address, base, prefix));
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0];
    // Only global unicast 2000::/3. Exclude documentation and transition/special
    // assignments; fail closed rather than trying to enumerate every special range.
    if (!normalized.startsWith('2') && !normalized.startsWith('3')) return false;
    if (/^2001:(?:0{0,3}[0-9a-f])?:/.test(normalized)) return false;
    if (normalized.startsWith('2001:db8:') || normalized.startsWith('2002:')) return false;
    return true;
  }
  return false;
}

function validateUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('URL inválida');
  }
  if (url.protocol !== 'https:') throw new Error('Solo se permiten URLs HTTPS');
  if (url.username || url.password) throw new Error('La URL no puede incluir credenciales');
  if (url.port && url.port !== '443') throw new Error('Solo se permite el puerto HTTPS estándar (443)');
  if (!url.hostname) throw new Error('La URL no tiene hostname');
  return url;
}

async function resolvePublic(hostname, resolver = dns.lookup) {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(normalizedHost);
  let records;
  if (literalFamily) {
    records = [{ address: normalizedHost, family: literalFamily }];
  } else {
    let timer;
    try {
      records = await Promise.race([
        resolver(normalizedHost, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout resolviendo DNS')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw new Error('El hostname resuelve a una dirección no pública o no permitida');
  }
  return records;
}

function requestOnce(url, addresses, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_BYTES, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const pinnedLookup = (_hostname, options, callback) => {
      const selected = addresses[0];
      if (options && options.all) callback(null, addresses);
      else callback(null, selected.address, selected.family);
    };
    const request = https.request(url, {
      method: 'GET',
      agent: false,
      lookup: pinnedLookup,
      headers: {
        'user-agent': 'FestivalMatch-LineupRadar/0.1 (+https://github.com/nelsoncabrera06/Festival-Match)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1',
        'accept-encoding': 'identity',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(new Error(`La respuesta supera el límite de ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`Timeout tras ${timeoutMs} ms`)));
    const deadline = setTimeout(() => request.destroy(new Error(`Tiempo total de request excedido (${timeoutMs} ms)`)), timeoutMs);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.end();
  });
}

async function fetchSource(inputUrl, options = {}) {
  const resolver = options.resolve || dns.lookup;
  const request = options.request || requestOnce;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  let url = validateUrl(inputUrl);
  // Requests condicionales: si el servidor responde 304 no se descarga el
  // cuerpo ni cambia el hash. Solo se envían si hay un estado previo.
  const conditionalHeaders = {};
  if (options.etag) conditionalHeaders['if-none-match'] = options.etag;
  if (options.lastModified) conditionalHeaders['if-modified-since'] = options.lastModified;

  for (let redirects = 0; ; redirects += 1) {
    const addresses = await resolvePublic(url.hostname, resolver);
    const response = await request(url, addresses, timeoutMs, maxBytes, conditionalHeaders);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirects >= maxRedirects) throw new Error(`Se superó el máximo de ${maxRedirects} redirecciones`);
      url = validateUrl(new URL(location, url).toString());
      continue;
    }

    if (response.status === 304) {
      return {
        status: 304,
        notModified: true,
        contentType: null,
        finalUrl: url.toString(),
        bytes: 0,
        hash: null,
        etag: options.etag || null,
        lastModified: options.lastModified || null,
        body: Buffer.alloc(0),
      };
    }

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Respuesta HTTP ${response.status}`);
      error.status = response.status;
      // Retry-After puede venir en segundos o como fecha HTTP. Se adjunta para
      // que el scheduler pueda respetarlo en vez de aplicar solo el backoff.
      const retryAfter = response.headers['retry-after'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
        else {
          const at = Date.parse(retryAfter);
          if (!Number.isNaN(at)) error.retryAfterMs = Math.max(0, at - Date.now());
        }
      }
      throw error;
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Content-Type no permitido: ${contentType || '(ausente)'}`);
    }
    return {
      status: response.status,
      notModified: false,
      contentType,
      finalUrl: url.toString(),
      bytes: response.body.length,
      hash: crypto.createHash('sha256').update(response.body).digest('hex'),
      etag: response.headers.etag || null,
      lastModified: response.headers['last-modified'] || null,
      body: response.body,
    };
  }
}

module.exports = {
  ALLOWED_CONTENT_TYPES,
  MAX_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  fetchSource,
  isPublicAddress,
  resolvePublic,
  validateUrl,
};

// CORS helper — whitelist por origem pra endpoints autenticados.
// Webhook é server-to-server (sem browser preflight) e usa `corsHeadersOpen`.
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173,https://altpay.devfellowship.com,https://ubermoney.devfellowship.com')
  .split(',').map((s) => s.trim()).filter(Boolean)

const BASE_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature, x-openpix-signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Vary': 'Origin',
}

function originFor(req?: Request) {
  const o = req?.headers.get('origin') ?? ''
  if (ALLOWED.includes(o)) return o
  // Aceita previews Vercel automaticamente (URLs *.vercel.app)
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(o)) return o
  return ALLOWED[0] ?? ''
}

export const corsHeaders = BASE_HEADERS
export const corsHeadersOpen = { ...BASE_HEADERS, 'Access-Control-Allow-Origin': '*' }

export const json = (body: unknown, status = 200, req?: Request, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': originFor(req),
      ...BASE_HEADERS,
      ...extra,
    },
  })

export const handleOptions = (req?: Request) =>
  new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': originFor(req), ...BASE_HEADERS },
  })

// Pro webhook (server-to-server, sem browser).
export const jsonOpen = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...BASE_HEADERS },
  })

export const handleOptionsOpen = () =>
  new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', ...BASE_HEADERS } })

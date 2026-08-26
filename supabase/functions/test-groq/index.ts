/**
 * test-groq — one-shot connectivity test for the Groq API key
 * Returns: { ok, model, response_preview, latency_ms, error? }
 * Never logs or returns the key itself.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GROQ_API_KEY secret is not configured in Supabase.',
    }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const t0 = Date.now();
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'user', content: 'Reply with exactly: {"status":"groq_ok","model":"llama-3.3-70b-versatile"}' },
        ],
        temperature: 0,
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const latency_ms = Date.now() - t0;

    if (!res.ok) {
      const txt = await res.text();
      return new Response(JSON.stringify({
        ok: false,
        model: GROQ_MODEL,
        latency_ms,
        http_status: res.status,
        error: txt.slice(0, 300),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await res.json();
    const content: string = body?.choices?.[0]?.message?.content ?? '';
    const usage = body?.usage ?? {};

    return new Response(JSON.stringify({
      ok: true,
      model: GROQ_MODEL,
      latency_ms,
      response_preview: content.slice(0, 200),
      usage,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      model: GROQ_MODEL,
      latency_ms: Date.now() - t0,
      error: String(err),
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

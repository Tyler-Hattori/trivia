/**
 * Ollama client — the project's only model dependency.
 *
 * Ollama serves an HTTP API on localhost:11434, which means this file is plain
 * `fetch` and the repo stays true to its zero-dependency, no-npm rule. Nothing
 * here needs Python or a package manager.
 *
 * Two models, two jobs:
 *
 *   EMBED  embeddinggemma (308M, 768 dims, ~200MB)   — required
 *          Turns an entry into the vector that decides where it lands.
 *
 *   WRITE  qwen3:8b (~5GB)                           — optional
 *          Reshapes a raw Wikipedia lead into the project's house voice and
 *          proposes topic tags. Only invoked with `--reshape`; without it the
 *          pipeline is entirely free of generative models and just uses
 *          Wikipedia's own prose.
 *
 * Override either with TRIVIA_EMBED_MODEL / TRIVIA_WRITE_MODEL.
 */

const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

export const EMBED_MODEL = process.env.TRIVIA_EMBED_MODEL || 'embeddinggemma';
export const WRITE_MODEL = process.env.TRIVIA_WRITE_MODEL || 'qwen3:8b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(route, body, { tries = 3, timeoutMs = 300_000 } = {}){
  let lastErr;
  for(let attempt = 0; attempt < tries; attempt++){
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(HOST + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if(!res.ok){
        const text = await res.text().catch(() => '');
        // A missing model is a user problem with a one-line fix, not a retry case.
        if(res.status === 404 && /model/i.test(text)){
          throw new Error(
            `Ollama has no model "${body.model}". Install it:\n\n    ollama pull ${body.model}\n`,
          );
        }
        throw new Error(`Ollama ${route} -> ${res.status} ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch(e){
      lastErr = e;
      if(/has no model/.test(e.message)) throw e;
      if(e.name === 'AbortError') lastErr = new Error(`Ollama ${route} timed out after ${timeoutMs}ms`);
      if(attempt < tries - 1) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Is the daemon up? Gives a precise error instead of a connection refused. */
export async function ensureUp(){
  try {
    const res = await fetch(HOST + '/api/tags');
    if(!res.ok) throw new Error(String(res.status));
    return (await res.json()).models || [];
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${HOST}.\n\n` +
      `  Start it:      ollama serve      (or open the Ollama app)\n` +
      `  Install it:    brew install ollama\n`,
    );
  }
}

/**
 * Embed a batch of strings. Returns `number[][]` in the input's order.
 *
 * Ollama's newer `/api/embed` takes an array; older builds only have
 * `/api/embeddings`, one string at a time. Try the fast path, fall back once.
 */
export async function embed(texts, model = EMBED_MODEL){
  if(!texts.length) return [];
  try {
    const d = await post('/api/embed', { model, input: texts });
    if(d?.embeddings?.length === texts.length) return d.embeddings;
    throw new Error('unexpected /api/embed response shape');
  } catch(e){
    if(/has no model/.test(e.message)) throw e;
    const out = [];
    for(const t of texts){
      const d = await post('/api/embeddings', { model, prompt: t });
      if(!d?.embedding) throw new Error(`Ollama returned no embedding for a ${t.length}-char input`);
      out.push(d.embedding);
    }
    return out;
  }
}

/**
 * One-shot completion. `format:'json'` constrains output to valid JSON.
 *
 * `numCtx` is a memory dial, not a quality one, and it is the one worth knowing
 * about: Ollama reserves a KV cache of `num_ctx * OLLAMA_NUM_PARALLEL` tokens
 * when it loads the model, on top of the weights. At the 8192 default served
 * four ways that is 32k tokens of cache for an 8B model, which is what pushed
 * this machine into swap during a long `excerpts.mjs` run. Callers whose prompts
 * are short should say so — a transform that peaks near 800 tokens has nothing to
 * gain from 8192 and pays for it in resident memory the whole time.
 *
 * `keepAlive` is how long the model stays loaded after the request ('30s', '1m').
 * Set it on the last stage of a long batch and the ~4.5 GB comes back on its own.
 */
export async function generate(prompt, {
  model = WRITE_MODEL, system, json = false, temperature = 0.2,
  numCtx = 8192, keepAlive,
} = {}){
  const d = await post('/api/generate', {
    model,
    prompt,
    system,
    stream: false,
    ...(json ? { format: 'json' } : {}),
    ...(keepAlive ? { keep_alive: keepAlive } : {}),
    // qwen3 interleaves <think> blocks unless thinking is off; they are pure
    // token cost here because every call is a short structured transform.
    think: false,
    options: { temperature, num_ctx: numCtx },
  });
  return String(d.response || '').trim();
}

/** `generate` with `format:'json'`, parsed. Returns null on unusable output. */
export async function generateJSON(prompt, opts = {}){
  const raw = await generate(prompt, { ...opts, json: true });
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if(m){ try { return JSON.parse(m[0]); } catch {} }
    return null;
  }
}

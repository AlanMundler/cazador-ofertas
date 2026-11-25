// Cloudflare Worker: dispara el workflow de GitHub cada 30 minutos.
// GitHub Actions throttlea los cron propios (vimos saltos de 6-11 h), este trigger no.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  async fetch(request, env) {
    const result = await dispatch(env);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function dispatch(env) {
  const repo = env.GITHUB_REPO || 'AlanMundler/cazador-ofertas';
  const workflow = env.WORKFLOW_FILE || 'scrape-markets.yml';
  const ref = env.GITHUB_REF || 'master';
  const startedAt = new Date().toISOString();

  if (!env.GITHUB_TOKEN) {
    return { ok: false, error: 'falta GITHUB_TOKEN', startedAt };
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'cazador-dispatch',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref }),
    },
  );

  const ok = response.status === 204;
  if (!ok) {
    const body = await response.text();
    console.log(`dispatch falló ${response.status}: ${body.slice(0, 300)}`);
  } else {
    console.log(`dispatch ok ${repo} ${workflow}@${ref} ${startedAt}`);
  }
  return { ok, status: response.status, repo, workflow, ref, startedAt };
}

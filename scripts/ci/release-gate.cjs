// Release readiness is tied to this exact commit, not an earlier green branch head.
const REQUIRED = ['test', 'real app (Windows, DPAPI)', 'packaged build, installer and service (disposable runner)', 'upgrade from the published 1.3.1 (disposable runner)'];
function assess(runs, jobs, sha) {
  const run = runs.filter(r => r.head_sha === sha).sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed') return { state: 'waiting' };
  if (run.conclusion !== 'success') return { state: 'failed', reason: 'latest CI run for this commit: ' + run.conclusion };
  if (!jobs) return { state: 'jobs', runId: run.id };
  const missing = REQUIRED.filter(name => !jobs.some(j => j.name === name && j.status === 'completed' && j.conclusion === 'success' && j.run_id === run.id));
  return missing.length ? { state: 'failed', reason: 'required checks missing or unsuccessful: ' + missing.join(', ') } : { state: 'ready', runId: run.id };
}
async function waitForCI({ repo, sha, token, request = fetch, now = Date.now, delay = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 30 * 60 * 1000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/.test(sha || '') || !token) throw new Error('release gate needs repository, exact commit and read token');
  const get = async route => {
    const r = await request('https://api.github.com/repos/' + repo + route, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('CI readiness API returned HTTP ' + r.status);
    return r.json();
  };
  const end = now() + timeoutMs;
  while (now() < end) {
    const runs = (await get('/actions/workflows/ci.yml/runs?head_sha=' + sha + '&per_page=50')).workflow_runs || [];
    let verdict = assess(runs, null, sha);
    if (verdict.state === 'jobs') {
      const jobs = (await get('/actions/runs/' + verdict.runId + '/jobs?filter=latest&per_page=100')).jobs || [];
      verdict = assess(runs, jobs, sha);
    }
    if (verdict.state === 'ready') { console.log('PASS full Windows CI for exact commit ' + sha + ' (run ' + verdict.runId + ')'); return verdict; }
    if (verdict.state === 'failed') throw new Error(verdict.reason);
    console.log('Waiting for the full Windows CI on ' + sha);
    await delay(15000);
  }
  throw new Error('full CI did not pass for this exact commit before the release deadline');
}
if (require.main === module) waitForCI({ repo: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, token: process.env.GH_TOKEN }).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { REQUIRED, assess, waitForCI };

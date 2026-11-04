// Runs the paper's path-traced close-ups unattended: each chunk of each pass loads a render page in
// a fresh iframe (a fresh WebGL context), is retried if the context is lost, and the chunks of every
// figure are then averaged.
//   /driver.html[?chunks=3&spp=96&w=1200&fstop=3.5]                 bracket close-ups (Figs. 1 and 5)
//   /driver.html?gallery=fixture-block:3,flange-adapter:5,…[&chunks…] multi-part gallery (gallery.html)

const params = new URLSearchParams(location.search);
const CHUNKS = Number(params.get('chunks') ?? 3);
const COMMON = { w: params.get('w') ?? '1200', spp: params.get('spp') ?? '96', fstop: params.get('fstop') ?? '3.5' };
const PASSES = ['coverage', 'deviation', 'groundtruth'];
/** Jobs: page, query per pass and chunk, and the output name (without -c<k>). */
const JOBS = params.get('gallery')
  ? params.get('gallery').split(',').map((s) => { const [part, trial] = s.split(':'); return { page: 'gallery', query: { part: `pilot-${part}`, trial }, name: (pass) => `parts/gallery/${part}-t${trial}-${pass}` }; })
  // Teaser (trial 2 from behind) and the results figure (trials 12 and 4 from the front-left).
  : [{ trial: 2, view: '0.28,0.22,-0.26', tag: 'back' }, { trial: 12 }, { trial: 4 }].map((shot) => ({
    page: 'bench', query: { stage: 'beauty', trial: shot.trial, ...(shot.view ? { view: shot.view } : {}), ...(shot.tag ? { tag: shot.tag } : {}) },
    name: (pass) => `fig-trial-${shot.trial}-${pass}-pt${shot.tag ? `-${shot.tag}` : ''}`,
  }));
const log = (s) => { document.getElementById('log').textContent += `${s}\n`; };

const TIMEOUT_MS = 6 * 60 * 1000;
const exists = async (name) => { const r = await fetch(`/out/${name}.png`, { method: 'HEAD' }); return r.ok && Number(r.headers.get('content-length') ?? 1e9) > 200000; };

function run(page, query) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = `/${page}.html?${new URLSearchParams(query)}`;
    document.body.appendChild(frame);
    // The page reports through postMessage; the timeout is only a backstop (timers are
    // throttled while the page is hidden, so it may fire late).
    const finish = (ok) => { window.removeEventListener('message', onMessage); clearTimeout(timer); frame.remove(); resolve(ok); };
    const onMessage = (e) => { if (e.source === frame.contentWindow && e.data?.bench) finish(e.data.bench === 'done'); };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
  });
}

for (const job of JOBS) {
  for (const pass of PASSES) {
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      if (await exists(`${job.name(pass)}-c${chunk}`)) continue;
      for (let attempt = 1; ; attempt++) {
        const t0 = performance.now();
        const ok = await run(job.page, { ...job.query, pass, chunk, ...COMMON });
        log(`${job.name(pass)} chunk ${chunk}: ${ok ? 'ok' : 'failed'} (${((performance.now() - t0) / 1000).toFixed(0)} s, attempt ${attempt})`);
        if (ok || attempt >= 4) break;
      }
    }
    const name = job.name(pass);
    if (await exists(name)) continue;
    await run('bench', { stage: 'average', name, n: CHUNKS });
    log(`→ ${name}.png`);
  }
  if (job.page === 'gallery') await run('gallery', { ...job.query, pass: 'crop' });
}
log('driver done');
window.__done = true;

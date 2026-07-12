let dataA = null, dataB = null;
let colRoles = {};
let compareResults = [];
let activeFilter = null;
const DISPLAY_CAP = 1000;
let webllmEngine = null;
let webllmModule = null;

// Dark mode is the default; toggle switches to light.
document.body.classList.add('dark');
document.getElementById('themeToggle').addEventListener('click', ()=>{
  const isDark = document.body.classList.toggle('dark');
  document.getElementById('themeToggle').textContent = isDark ? '☀ Light mode' : '🌙 Dark mode';
});

// ---------- File loading (worker-based parse) ----------
function setupDropzone(zoneId, inputId, nameId, infoId, which){
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  // Note: zone is a <label> wrapping the file input, so clicking it already
  // natively opens the picker — no manual input.click() needed (that was
  // firing it a second time and causing the "select twice" bug).
  zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', ()=> zone.classList.remove('drag'));
  zone.addEventListener('drop', e=>{
    e.preventDefault(); zone.classList.remove('drag');
    if(e.dataTransfer.files.length){ input.files = e.dataTransfer.files; handleFile(input.files[0], which, nameId, infoId); }
  });
  input.addEventListener('change', ()=>{ if(input.files.length) handleFile(input.files[0], which, nameId, infoId); });
}
function handleFile(file, which, nameId, infoId){
  document.getElementById(nameId).textContent = file.name;
  document.getElementById(infoId).textContent = 'Parsing…';
  Papa.parse(file, {
    header:true, skipEmptyLines:true, worker:true,
    complete: res=>{
      const fields = res.meta.fields || [];
      const rows = res.data;
      document.getElementById(infoId).textContent = `${rows.length.toLocaleString()} rows · ${fields.length} columns`;
      if(which === 'A') dataA = {fields, rows}; else dataB = {fields, rows};
      maybeShowStep2();
    },
    error: err=>{ document.getElementById(infoId).textContent = 'Could not parse file: '+err.message; }
  });
}
setupDropzone('dzA','fileA','dzAName','dzAInfo','A');
setupDropzone('dzB','fileB','dzBName','dzBInfo','B');

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- Step 2: column config ----------
function maybeShowStep2(){
  if(!dataA || !dataB) return;
  const common = dataA.fields.filter(f=> dataB.fields.includes(f));
  const onlyA = dataA.fields.filter(f=> !dataB.fields.includes(f));
  const onlyB = dataB.fields.filter(f=> !dataA.fields.includes(f));

  colRoles = {};
  common.forEach(f=>{
    if(/(^id$|_id$|\bid\b|code|key)/i.test(f)) colRoles[f]='key';
    else if(/date|day/i.test(f)) colRoles[f]='key';
    else colRoles[f]='compare';
  });
  if(!Object.values(colRoles).includes('key') && common.length) colRoles[common[0]]='key';

  const box = document.getElementById('colConfig');
  box.innerHTML = '';
  if(common.length === 0){
    box.innerHTML = `<p style="color:var(--mismatch-fg); font-size:13px;">No matching column names between the two files — rename headers to align them (e.g. both need an "ID" or "Date" column) and re-upload.</p>`;
  } else {
    const group = document.createElement('div');
    group.className = 'col-group';
    group.innerHTML = `<h3>Common columns — Key (joins rows), Compare (judged for content), or Context (shown for reference, never judged/sent to AI)</h3>`;
    common.forEach(f=>{
      const row = document.createElement('div');
      row.className = 'col-row';
      row.innerHTML = `<span class="name">${escapeHtml(f)}</span>
        <div class="seg" data-col="${escapeHtml(f)}">
          <button data-role="key" class="${colRoles[f]==='key'?'active key':''}">Key</button>
          <button data-role="compare" class="${colRoles[f]==='compare'?'active compare':''}">Compare</button>
          <button data-role="context" class="${colRoles[f]==='context'?'active context':''}">Context</button>
          <button data-role="ignore" class="${colRoles[f]==='ignore'?'active ignore':''}">Ignore</button>
        </div>`;
      group.appendChild(row);
    });
    box.appendChild(group);
    box.querySelectorAll('.seg button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const seg = btn.parentElement; const col = seg.dataset.col;
        colRoles[col] = btn.dataset.role;
        seg.querySelectorAll('button').forEach(b=>b.classList.remove('active','key','compare','context','ignore'));
        btn.classList.add('active', btn.dataset.role);
      });
    });
  }
  const extraBox = document.getElementById('extraColsBox');
  let extraHtml = '';
  if(onlyA.length) extraHtml += `<div class="extra-cols"><b>Only in A:</b> ${onlyA.map(escapeHtml).join(', ')} (context only)</div>`;
  if(onlyB.length) extraHtml += `<div class="extra-cols" style="margin-top:4px;"><b>Only in B:</b> ${onlyB.map(escapeHtml).join(', ')} (context only)</div>`;
  extraBox.innerHTML = extraHtml;
  document.getElementById('step2').classList.remove('hidden');
  const uploadEl = document.getElementById('uploadSection');
  if(uploadEl.tagName === 'DETAILS') uploadEl.open = false; // fold away now that both files are loaded
}

// ---------- Fast heuristic ----------
function normText(s){ return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function isNumeric(s){ if(s===null||s===undefined||String(s).trim()==='') return false; return !isNaN(parseFloat(s)) && isFinite(String(s).trim()); }
function jaccard(a,b){
  const A = new Set(normText(a).split(' ').filter(Boolean));
  const B = new Set(normText(b).split(' ').filter(Boolean));
  if(A.size===0 && B.size===0) return 1;
  const inter = [...A].filter(x=>B.has(x)).length;
  const union = new Set([...A,...B]).size;
  return union===0 ? 1 : inter/union;
}
function heuristicCompare(aRow, bRow, compareCols){
  if(compareCols.length===0) return {status:'match', reason:'No compare columns selected — matched on key only.', score:1, hasNumericDiff:false};
  let diffs = []; let sims = []; let hasNumericDiff = false;
  compareCols.forEach(col=>{
    const av = aRow[col], bv = bRow[col];
    if(isNumeric(av) && isNumeric(bv)){
      const same = Math.abs(parseFloat(av)-parseFloat(bv)) < 1e-9;
      sims.push(same?1:0);
      if(!same){ diffs.push(`${col}: ${av} vs ${bv}`); hasNumericDiff = true; }
    } else {
      const sim = jaccard(av,bv);
      sims.push(sim);
      if(sim < 0.999 || String(av)!==String(bv)) diffs.push(`${col}: "${av}" vs "${bv}"`);
    }
  });
  const avg = sims.reduce((a,b)=>a+b,0)/sims.length;
  if(diffs.length===0) return {status:'match', reason:'All compared fields agree exactly.', score:1, hasNumericDiff:false};
  return {status:'mismatch', reason:diffs.join('\n'), score:avg, hasNumericDiff};
}
function rowDesc(row, cols){ if(!row) return ''; return cols.map(c=> `${c}: ${row[c]}`).join('\n'); }
// Escapes text for HTML, then converts real newlines to <br> so the multi-line
// plain-text strings above render as separate lines instead of one run-on string.
function toDisplayHtml(text){ return escapeHtml(text).replace(/\n/g, '<br>'); }

// ---------- Phase 1: Fast comparison ----------
document.getElementById('runBtn').addEventListener('click', runFastComparison);

function runFastComparison(){
  const runBtn = document.getElementById('runBtn');
  const statusEl = document.getElementById('runStatus');
  const keyCols = Object.keys(colRoles).filter(c=>colRoles[c]==='key');
  const compareCols = Object.keys(colRoles).filter(c=>colRoles[c]==='compare');
  const contextCols = Object.keys(colRoles).filter(c=>colRoles[c]==='context');
  const displayCols = [...compareCols, ...contextCols]; // context columns show for humans but are NEVER judged or sent to the AI
  if(keyCols.length===0){ statusEl.textContent = 'Select at least one Key column.'; return; }

  runBtn.disabled = true;
  statusEl.innerHTML = '<span class="spinner"></span>Joining rows…';

  setTimeout(()=>{
    const keyOf = row => keyCols.map(c=> (row[c]??'').toString().trim()).join('‖');
    const mapA = new Map(); dataA.rows.forEach(r=> mapA.set(keyOf(r), r));
    const mapB = new Map(); dataB.rows.forEach(r=> mapB.set(keyOf(r), r));
    const allKeys = [...new Set([...mapA.keys(), ...mapB.keys()])];

    const results = [];
    allKeys.forEach(k=>{
      const a = mapA.get(k), b = mapB.get(k);
      if(a && b){
        const r = heuristicCompare(a, b, compareCols);
        results.push({key:k, status:r.status==='match'?'MATCH':'MISMATCH', a, b, reason:r.reason, score:r.score, hasNumericDiff:r.hasNumericDiff, aiChecked:false});
      } else if(a && !b){
        results.push({key:k, status:'A_ONLY', a, b:null, reason:'No matching key in B.', score:0, aiChecked:false});
      } else {
        results.push({key:k, status:'B_ONLY', a:null, b, reason:'No matching key in A.', score:0, aiChecked:false});
      }
    });
    results.sort((x,y)=> x.key.localeCompare(y.key));
    compareResults = results.map(r=>({...r, keyCols, compareCols, displayCols}));

    renderResults();
    updateAiQueueInfo();
    const step2El = document.getElementById('step2');
    if(step2El.tagName === 'DETAILS') step2El.open = false; // fold away now that Fast is done
    runBtn.disabled = false;
    statusEl.textContent = 'Done.';
  }, 10);
}

// ---------- AI review queue / thresholds ----------
function getAiQueue(){
  // Only rows Fast flagged as mismatches are candidates — matches are already
  // safe, A/B-only need no semantics. Critically, rows where a NUMBER itself
  // disagrees are excluded too: that's already a conclusive, code-verified
  // fact with no ambiguity to resolve — asking an LLM to "reconsider" it only
  // risks it overriding a correct answer with a wrong one (which is exactly
  // what was observed: a small model overturning genuine numeric mismatches).
  // AI review is reserved for the one question that's actually ambiguous:
  // do the wording-only differences still mean the same thing.
  const queue = compareResults.filter(r=> r.status==='MISMATCH' && !r.aiChecked && !r.hasNumericDiff);
  queue.sort((x,y)=> y.score - x.score); // closest-to-match first: most likely to flip, most valuable to recheck
  return queue;
}
function tierFor(n){
  if(n===0) return {cls:'info', label:'No mismatches to review.'};
  if(n<=500) return {cls:'info', label:`~5–15 min expected.`};
  if(n<=2000) return {cls:'warn', label:`~15–60 min expected — fine to run in the background.`};
  return {cls:'warn', label:`1+ hours expected — treat as an unattended/overnight job. Consider setting a cap below.`};
}
function updateAiQueueInfo(){
  const queue = getAiQueue();
  const numericExcluded = compareResults.filter(r=> r.status==='MISMATCH' && r.hasNumericDiff).length;
  const t = tierFor(queue.length);
  const box = document.getElementById('aiQueueInfo');
  box.className = 'banner ' + t.cls;
  box.textContent = `${queue.length.toLocaleString()} row(s) have wording-only differences and are eligible for AI review. ${t.label}`
    + (numericExcluded ? ` (${numericExcluded.toLocaleString()} other mismatch(es) have a differing number — already conclusive, so they're skipped rather than sent for AI review.)` : '');
}

document.getElementById('aiModes').addEventListener('click', e=>{
  const opt = e.target.closest('.ai-opt'); if(!opt) return;
  document.querySelectorAll('.ai-opt').forEach(o=>o.classList.remove('active'));
  opt.classList.add('active');
  const mode = opt.dataset.mode;
  document.getElementById('cloudFields').classList.toggle('hidden', mode!=='cloud');
  document.getElementById('localFields').classList.toggle('hidden', mode!=='local');
  document.getElementById('aiError').classList.add('hidden');
});

// ---------- WebLLM (local) ----------
async function loadLocalModel(){
  const statusEl = document.getElementById('modelLoadStatus');
  const barOuter = document.getElementById('modelLoadBarOuter');
  const bar = document.getElementById('modelLoadBar');
  if(!('gpu' in navigator)){
    statusEl.textContent = 'WebGPU not available in this browser (try Chrome/Edge, or check org IT policy).';
    return false;
  }
  try{
    statusEl.innerHTML = '<span class="spinner"></span>Loading WebLLM library…';
    if(!webllmModule){
      // Fetched only now, on demand — not part of the initial page load.
      webllmModule = await import('https://esm.run/@mlc-ai/web-llm');
    }
    // Loading a second/different model while one is already resident is a common
    // cause of the quota error below — release it first.
    if(webllmEngine){
      try{ await webllmEngine.unload(); }catch(_){}
      webllmEngine = null;
    }
    const modelId = document.getElementById('localModelSelect').value;
    barOuter.style.display = 'block';
    webllmEngine = await webllmModule.CreateMLCEngine(modelId, {
      initProgressCallback: (p)=>{
        bar.style.width = Math.round((p.progress||0)*100) + '%';
        statusEl.textContent = p.text || 'Loading…';
      }
    });
    statusEl.textContent = 'Model loaded and ready.';
    return true;
  }catch(e){
    const isQuota = /quota/i.test(e.name||'') || /quota/i.test(e.message||'');
    if(isQuota){
      let usageInfo = '';
      try{
        const est = await navigator.storage.estimate();
        usageInfo = ` (browser reports ~${(est.usage/1e6).toFixed(0)}MB used of ~${(est.quota/1e6).toFixed(0)}MB allotted to this site)`;
      }catch(_){}
      statusEl.innerHTML = `Storage quota exceeded${usageInfo}. This usually means: (1) a previous model's files are still cached and the new one doesn't fit, or (2) this page is open via file:// rather than a real server, which often gets a much smaller storage allowance. Try "Clear cached model files" below, or serve this file from a local server (e.g. <code>npx serve</code>) instead of double-clicking it.`;
    } else {
      statusEl.textContent = 'Failed to load model: ' + e.message;
    }
    return false;
  }
}
document.getElementById('loadModelBtn').addEventListener('click', loadLocalModel);

document.getElementById('clearModelCacheBtn').addEventListener('click', async ()=>{
  const statusEl = document.getElementById('modelLoadStatus');
  try{
    if(webllmEngine){ try{ await webllmEngine.unload(); }catch(_){} webllmEngine = null; }
    const names = await caches.keys();
    const targets = names.filter(n=> /webllm|mlc/i.test(n));
    await Promise.all(targets.map(n=> caches.delete(n)));
    statusEl.textContent = targets.length
      ? `Cleared ${targets.length} cached model store(s). Try loading again.`
      : 'No WebLLM cache entries found (they may be stored under a different name in this browser).';
  }catch(e){
    statusEl.textContent = 'Could not clear cache: ' + e.message;
  }
});

// Shared decision rubric. Numeric/value fields are verified equal by CODE
// before a row ever reaches here (see getAiQueue) — so the model is never
// asked to re-check numbers, and can't override a number-based mismatch.
// It's only asked the one question that's genuinely ambiguous: do the
// differing TEXT labels still refer to the same thing. Deliberately about
// *patterns*, not specific vocabulary, so it generalizes to any CSV.
const AI_RUBRIC = `The numeric/value fields for this pair have already been verified equal by separate logic — do not question or re-evaluate them. Your only job: read the TEXT label(s) below and decide — is this wording variation of ONE task, or does it name a DIFFERENT task? Apply these rules:
1. If one label is an abbreviation, expansion, or synonym of the other naming the same task (e.g. "Config Setup" and "Configuration Setup"), answer MATCH even though the wording differs.
2. If labels share the same words but their relationship is reversed or swapped (e.g. two attributes traded places, like "red box on top of blue box" vs "blue box on top of red box"), answer MISMATCH — high word overlap does not mean same meaning.
These are illustrative patterns, not a fixed vocabulary list — apply the same logic to whatever labels actually appear, in any domain.`;

const AI_SYSTEM_PROMPT = `You are given paired rows from two files, A and B, already lined up by matching key/date/ID — that pairing itself is settled, not what you're judging. ${AI_RUBRIC}
For each pair, first briefly reason using the row's own specific wording (not generic restatement), then decide. Respond ONLY with a JSON array, no prose, no markdown fences, one object per input pair, with reasoning BEFORE status so you think it through first: {"key":..., "reasoning":"one short clause quoting or referencing the actual labels, max 15 words", "status":"match"|"mismatch"}.`;

function buildPayload(pairs, compareCols){
  return pairs.map(p=>({
    key: p.key,
    a: Object.fromEntries(compareCols.map(c=>[c, p.a[c]])),
    b: Object.fromEntries(compareCols.map(c=>[c, p.b[c]]))
  }));
}
function parseJsonLenient(text){
  const clean = text.replace(/```json|```/g,'').trim();
  // 1) straightforward parse
  try{ return JSON.parse(clean); }catch(e){}

  // 2) structural repair for truncated/malformed output: walk the text tracking
  //    open brackets/braces (as a stack, so we close them in the right order/type)
  //    and whether we're stuck inside an unterminated string. Small local models
  //    frequently cut off mid-sentence, leaving a dangling quote — that alone
  //    breaks JSON.parse even though every earlier element was fine.
  const stack = [];
  let inStr = false, esc = false;
  for(let i=0;i<clean.length;i++){
    const c = clean[i];
    if(inStr){
      if(esc) esc = false;
      else if(c === '\\') esc = true;
      else if(c === '"') inStr = false;
      continue;
    }
    if(c === '"'){ inStr = true; continue; }
    if(c === '[' || c === '{') stack.push(c);
    else if(c === ']' || c === '}') stack.pop();
  }
  let repaired = clean.replace(/,\s*$/, '');
  if(inStr) repaired += '"';                                  // close the dangling string first
  for(let k=stack.length-1; k>=0; k--) repaired += stack[k]==='[' ? ']' : '}'; // then close nesting, innermost first
  try{ return JSON.parse(repaired); }catch(e){}

  // 3) last resort: discard the broken tail entirely, keeping only complete
  //    elements from the outer array.
  let depth = 0, lastGoodEnd = -1; inStr = false; esc = false;
  for(let i=0;i<clean.length;i++){
    const c = clean[i];
    if(inStr){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inStr=false; continue; }
    if(c==='"'){ inStr=true; continue; }
    if(c==='['||c==='{') depth++;
    else if(c===']'||c==='}'){ depth--; if(depth===1) lastGoodEnd=i; }
  }
  if(lastGoodEnd > 0){
    try{ return JSON.parse(clean.slice(0,lastGoodEnd+1) + ']'); }catch(e){}
  }
  throw new Error('unparseable');
}

// Small local models often don't follow the exact {key,status,reason} schema —
// they may drop the key, or return bare ["mismatch","reason..."] tuples. This
// normalizes whatever shape came back, matching by key when present/valid,
// falling back to input order (position) otherwise.
function normalizeAiResults(parsed, batch){
  if(!Array.isArray(parsed)) throw new Error('AI response was not a JSON array.');
  const byKey = new Map();
  const validKeys = new Set(batch.map(p=>p.key));
  const out = new Array(batch.length).fill(null);

  parsed.forEach((item, idx)=>{
    let key=null, status=null, reason='';
    if(item && typeof item === 'object' && !Array.isArray(item)){
      key = item.key; status = item.status; reason = item.reasoning || item.reason || '';
    } else if(Array.isArray(item)){
      // tuple shape: find the status-like string and treat the longest other string as the reason
      const strs = item.filter(x=> typeof x === 'string');
      status = strs.find(s=> /match|mismatch/i.test(s)) || strs[0];
      reason = strs.filter(s=> s !== status).sort((a,b)=> b.length-a.length)[0] || '';
      if(strs.length >= 3) key = strs.find(s=> validKeys.has(s)) || null;
    } else if(typeof item === 'string'){
      status = /mismatch/i.test(item) ? 'mismatch' : (/match/i.test(item) ? 'match' : null);
      reason = item;
    }
    const normalized = {status: (status||'mismatch').toLowerCase().includes('mismatch') ? 'mismatch' : ((status||'').toLowerCase()==='match'?'match':'mismatch'), reason: sanitizeAiReason(reason)};
    if(key && validKeys.has(key) && !byKey.has(key)){
      byKey.set(key, normalized);
    } else if(idx < out.length){
      out[idx] = normalized; // positional fallback
    }
  });

  return batch.map((p, idx)=> byKey.get(p.key) || out[idx] || {status:'mismatch', reason:'No AI result returned for this row (response incomplete or unparseable).'});
}

async function cloudCompareBatch(pairs, compareCols, apiKey){
  const payload = buildPayload(pairs, compareCols);
  const headers = {'Content-Type':'application/json'};
  if(apiKey){ headers['x-api-key']=apiKey; headers['anthropic-version']='2023-06-01'; headers['anthropic-dangerous-direct-browser-access']='true'; }
  let resp;
  try{
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers,
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:1000, system:AI_SYSTEM_PROMPT, messages:[{role:'user', content:JSON.stringify(payload)}] })
    });
  }catch(networkErr){
    throw new Error(`Network/CORS failure (${networkErr.message}). If running outside claude.ai, paste an API key above.`);
  }
  if(!resp.ok){ let t=''; try{t=await resp.text();}catch(_){} throw new Error(`Anthropic API returned ${resp.status} ${resp.statusText}. ${t.slice(0,300)}`); }
  const data = await resp.json();
  if(data.error) throw new Error(`API error: ${data.error.type||''} ${data.error.message||JSON.stringify(data.error)}`);
  const text = (data.content||[]).map(b=>b.text||'').join('');
  try{ return parseJsonLenient(text); }
  catch(e){ throw new Error(`Could not parse response as JSON. Raw start: ${text.slice(0,200)}`); }
}

// Local models this small are unreliable at multi-item JSON. So instead of
// batching rows into one structured response, we ask about ONE row at a time,
// in the simplest possible shape. Reasoning is asked for FIRST and the verdict
// LAST — small models lean much more heavily than large ones on actually
// writing out the reasoning before committing to an answer; asking for the
// verdict up front (as we did originally) skips the step that helps them most.
const LOCAL_FEWSHOT = `Example A: Item A {"label":"Config Setup"} vs Item B {"label":"Configuration Setup"} -> reasoning: "Configuration" is just the unabbreviated form of "Config", same thing -> MATCH
Example B: Item A {"desc":"red box on top of blue box"} vs Item B {"desc":"blue box on top of red box"} -> reasoning: same words but the relationship is reversed -> MISMATCH`;

async function localCompareSingle(pair, compareCols){
  const a = Object.fromEntries(compareCols.map(c=>[c, pair.a[c]]));
  const b = Object.fromEntries(compareCols.map(c=>[c, pair.b[c]]));
  const userMsg = `Item A: ${JSON.stringify(a)}\nItem B: ${JSON.stringify(b)}\n\n(Numeric/value fields already verified equal — ignore those.) First, on line 1, briefly reason (max 12 words) about whether the differing text label(s) still mean the same thing. Then, on line 2, output exactly one word: MATCH or MISMATCH.`;
  const completion = await webllmEngine.chat.completions.create({
    messages: [
      {role:'system', content:`Item A and Item B are already lined up by matching ID/date — that pairing is settled, not what you're judging. ${AI_RUBRIC}\n\nHere are worked examples of the pattern (these are generic illustrations, not the actual data you'll see):\n${LOCAL_FEWSHOT}\n\nAlways answer in exactly two lines: a short reason first, then the verdict word. Never leave line 1 blank — always write at least a few words about the specific labels you were given. No JSON, no extra commentary.`},
      {role:'user', content:userMsg}
    ],
    temperature: 0,
    max_tokens: 120 // generous: the verdict is now the LAST token out, so truncation risk is worse than before
  });
  const text = (completion.choices?.[0]?.message?.content || '').trim();
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);

  // Verdict is expected last (reasoning-first format) — search from the end
  // for a clear MATCH/MISMATCH signal rather than assuming line position.
  let verdictIdx = -1;
  for(let i=lines.length-1; i>=0; i--){
    if(/\b(match|mismatch)\b/i.test(lines[i])){ verdictIdx = i; break; }
  }
  if(verdictIdx === -1){
    // Model never clearly stated a verdict anywhere — default to mismatch
    // (flag for human review) rather than guessing match.
    return {status:'mismatch', reason: sanitizeAiReason(lines.join(' '), '')};
  }
  const status = /mismatch/i.test(lines[verdictIdx]) ? 'mismatch' : 'match';
  let reasonLines = lines.slice(0, verdictIdx);
  if(reasonLines.length === 0){
    const line = lines[verdictIdx];
    let m = line.match(/^(.*?)[-:—]\s*(?:match|mismatch)\s*$/i);       // "<reason> - MISMATCH"
    if(m && m[1].trim()) reasonLines = [m[1].trim()];
    else {
      m = line.match(/^(?:match|mismatch)\s*[-:—]\s*(.+)$/i);          // "MISMATCH - <reason>"
      if(m) reasonLines = [m[1]];
    }
  }
  return {status, reason: sanitizeAiReason(reasonLines.join(' '), lines[verdictIdx])};
}

// Strips out degenerate "reasons" that are really just the model repeating its
// own verdict (e.g. a bare "MISMATCH") or otherwise empty — returns '' in that
// case so the caller can fall back to Fast mode's own factual diff instead of
// displaying a placeholder like "Mismatch — MISMATCH".
function sanitizeAiReason(raw, statusLineText){
  let r = (raw||'').trim();
  // model sometimes puts everything on one line: "MISMATCH - values differ"
  if(!r && statusLineText){
    const m = statusLineText.match(/^(?:MATCH|MISMATCH)\s*[-:—]\s*(.+)$/i);
    if(m) r = m[1].trim();
  }
  if(!r || /^(match|mismatch)[.!]?$/i.test(r)) return '';
  return r;
}

// Detect hedging language in the model's own stated reason (e.g. "possibly",
// "unclear", "might be") — a lightweight way to flag verdicts worth a human
// glance without needing the model to reliably output a separate, strictly-
// formatted confidence field (which would add its own failure surface).
const HEDGE_PATTERN = /\b(possibly|maybe|might|could be|may be|unsure|uncertain|unclear|not certain|hard to tell|not sure|ambiguous|seems? to|appears? to|likely|probably)\b/i;
function hasHedgeLanguage(text){ return HEDGE_PATTERN.test(text||''); }

// Catches a real failure mode observed in practice: the model's own reasoning
// says "same real-world thing" / "equivalent" and then its verdict is MISMATCH
// anyway (or the reverse) — internal incoherence rather than a genuine
// borderline case. Flag these for a human glance rather than trusting either
// half of a self-contradictory answer.
const IMPLIES_MATCH = /(same (real[- ]world )?thing|same (goal|item|meaning|label)|equivalent|refers? to the same|essentially (the same|identical)|no (real )?difference)/i;
const IMPLIES_MISMATCH = /(different (thing|goal|item|meaning|label)s?|not the same|distinct|does(?:n't| not) match|no match)/i;
function reasoningContradictsVerdict(reason, status){
  const r = reason || '';
  const impliesMatch = IMPLIES_MATCH.test(r);
  const impliesMismatch = IMPLIES_MISMATCH.test(r);
  if(status === 'mismatch' && impliesMatch && !impliesMismatch) return true;
  if(status === 'match' && impliesMismatch && !impliesMatch) return true;
  return false;
}

// ---------- Phase 2: AI review run ----------
document.getElementById('startAiBtn').addEventListener('click', runAiReview);

async function runAiReview(){
  const mode = document.querySelector('.ai-opt.active').dataset.mode;
  const startBtn = document.getElementById('startAiBtn');
  const statusEl = document.getElementById('aiStatus');
  const errBox = document.getElementById('aiError');
  const barOuter = document.getElementById('aiBarOuter');
  const bar = document.getElementById('aiBar');
  errBox.classList.add('hidden');

  let queue = getAiQueue();
  const capVal = parseInt(document.getElementById('capInput').value, 10);
  if(!isNaN(capVal) && capVal > 0) queue = queue.slice(0, capVal);
  if(queue.length === 0){ statusEl.textContent = 'No rows to review.'; return; }

  if(mode === 'local' && !webllmEngine){
    statusEl.textContent = 'Load the model first.';
    const ok = await loadLocalModel();
    if(!ok) return;
  }
  const apiKey = document.getElementById('apiKeyInput').value.trim();

  startBtn.disabled = true;
  barOuter.style.display = 'block';
  const compareCols = queue[0].compareCols;
  const batchSize = mode === 'local' ? 1 : 8; // local: one row at a time, plain text — no JSON to break
  const total = queue.length;
  let done = 0;
  const startTime = performance.now();

  for(let i=0; i<total; i+=batchSize){
    const batch = queue.slice(i, i+batchSize);
    const elapsed = (performance.now()-startTime)/1000;
    const rate = done>0 ? done/elapsed : null;
    const etaTxt = rate ? `~${Math.ceil((total-done)/rate)}s remaining (${rate.toFixed(2)} rows/sec)` : 'estimating…';
    statusEl.innerHTML = `<span class="spinner"></span>Reviewing ${done}/${total} — ${etaTxt}`;
    bar.style.width = Math.round(done/total*100) + '%';

    try{
      let normalized;
      if(mode === 'cloud'){
        const rawOut = await cloudCompareBatch(batch, compareCols, apiKey);
        normalized = normalizeAiResults(rawOut, batch);
      } else {
        // one plain-text call per row — sequential, since it's a single local WebGPU context
        normalized = [await localCompareSingle(batch[0], compareCols)];
      }
      batch.forEach((p, idx)=>{
        const o = normalized[idx];
        const target = compareResults.find(r=> r.key === p.key);
        if(target){
          const baseReason = (target.reason||'').replace(/\s*\[AI-reviewed\]\s*$/,'');
          target.status = o.status === 'match' ? 'MATCH' : 'MISMATCH';
          target.reason = (o.reason || baseReason) + ' [AI-reviewed]';
          target.aiChecked = true;
          target.uncertain = hasHedgeLanguage(o.reason) || reasoningContradictsVerdict(o.reason, o.status);
        }
      });
    }catch(e){
      errBox.classList.remove('hidden');
      errBox.textContent = '⚠ AI review stopped: ' + e.message + `\n(${done} of ${total} rows were reviewed before this happened — those results are kept. Click "Start AI review" again to resume with the remaining rows.)`;
      startBtn.disabled = false;
      renderResults();
      return;
    }
    done += batch.length;
  }

  bar.style.width = '100%';
  statusEl.textContent = `Done — reviewed ${total} row(s) in ${((performance.now()-startTime)/1000).toFixed(0)}s.`;
  startBtn.disabled = false;
  renderResults();
}

// ---------- Rendering ----------
function renderResults(){
  const counts = {MATCH:0, MISMATCH:0, A_ONLY:0, B_ONLY:0};
  compareResults.forEach(r=> counts[r.status]++);
  const tally = document.getElementById('tally');
  const tallyDefs = [
    {k:null, label:'Rows in A', val:dataA.rows.length, bg:'var(--tile-bg)'},
    {k:null, label:'Rows in B', val:dataB.rows.length, bg:'var(--surface)'},
    {k:'MATCH', label:'Match', val:counts.MATCH, bg:'var(--match-bg)'},
    {k:'MISMATCH', label:"Don't Match", val:counts.MISMATCH, bg:'var(--mismatch-bg)'},
    {k:'A_ONLY', label:'A Only', val:counts.A_ONLY, bg:'var(--aonly-bg)'},
    {k:'B_ONLY', label:'B Only', val:counts.B_ONLY, bg:'var(--bonly-bg)'},
  ];
  tally.innerHTML = tallyDefs.map(d=>`<div class="cell" data-filter="${d.k??''}" style="background:${d.k===activeFilter?d.bg:'transparent'}"><span class="num">${d.val}</span><span class="lbl">${d.label}</span></div>`).join('');
  tally.querySelectorAll('.cell[data-filter]').forEach(c=>{
    c.addEventListener('click', ()=>{
      const f = c.dataset.filter || null; if(!f) return;
      activeFilter = (activeFilter===f) ? null : f;
      renderResults();
    });
  });

  const head = document.getElementById('resultHead');
  head.innerHTML = `<th>Key</th><th>Rows in A</th><th>Rows in B</th><th>Status</th><th>Because…</th>`;

  document.getElementById('results').classList.remove('hidden');
  updateAiQueueInfo();
  renderTable();
}

function renderTable(){
  const body = document.getElementById('resultBody');
  const capBanner = document.getElementById('capBanner');
  const q = (document.getElementById('searchBox').value||'').toLowerCase();
  const filtered = compareResults.filter(r=>{
    if(activeFilter && r.status!==activeFilter) return false;
    if(!q) return true;
    const hay = (r.key+' '+rowDesc(r.a,r.displayCols)+' '+rowDesc(r.b,r.displayCols)+' '+(r.reason||'')).toLowerCase();
    return hay.includes(q);
  });
  const shown = filtered.slice(0, DISPLAY_CAP);
  capBanner.textContent = filtered.length > DISPLAY_CAP
    ? `Showing ${DISPLAY_CAP.toLocaleString()} of ${filtered.length.toLocaleString()} matching rows — narrow your search/filter, or use Export CSV for the full set.`
    : `Showing all ${filtered.length.toLocaleString()} matching row(s).`;

  const STATUS_META = {
    MATCH:    {cls:'row-match',    badge:'badge match',    label:'Match',    verb:'Match'},
    MISMATCH: {cls:'row-mismatch', badge:'badge mismatch', label:'Mismatch', verb:'Mismatch'},
    A_ONLY:   {cls:'row-aonly',    badge:'badge aonly',    label:'A only',   verb:'Only in A'},
    B_ONLY:   {cls:'row-bonly',    badge:'badge bonly',    label:'B only',   verb:'Only in B'},
  };
  const rowsHtml = shown.map(r=>{
    const aDescRaw = rowDesc(r.a, r.displayCols);
    const bDescRaw = rowDesc(r.b, r.displayCols);
    const aDesc = aDescRaw ? toDisplayHtml(aDescRaw) : '<span style="color:#B0ADA3">—</span>';
    const bDesc = bDescRaw ? toDisplayHtml(bDescRaw) : '<span style="color:#B0ADA3">—</span>';
    const aiTag = r.aiChecked ? '<span class="badge ai">AI</span>' : '';
    const uncertainTag = r.uncertain ? '<span class="badge mismatch" title="The AI hedged its wording, or its stated reasoning contradicts its own verdict — worth a human glance.">⚠ uncertain</span>' : '';
    const meta = STATUS_META[r.status];
    let becauseText;
    if(r.status==='A_ONLY') becauseText = 'No matching key found in File B for this row.';
    else if(r.status==='B_ONLY') becauseText = 'No matching key found in File A for this row.';
    else becauseText = r.reason || '';
    const verdictHtml = `<span class="${meta.badge}">${meta.label}</span>${aiTag}${uncertainTag}`;
    return `<tr class="${meta.cls}"><td class="key-col">${escapeHtml(r.key.replace(/‖/g,' / '))}</td><td>${aDesc}</td><td>${bDesc}</td><td>${verdictHtml}</td><td class="verdict">${toDisplayHtml(becauseText)}</td></tr>`;
  }).join('');
  body.innerHTML = rowsHtml || `<tr><td colspan="5" style="text-align:center; color:var(--ink-soft); padding:30px;">No rows match your filter/search.</td></tr>`;
}
document.getElementById('searchBox').addEventListener('input', renderTable);

document.getElementById('exportBtn').addEventListener('click', ()=>{
  const rows = [['Key','Rows in A','Rows in B','Status','AI Reviewed','Uncertain','Match Detail','Mismatch Detail','A Only','B Only','Reason']];
  compareResults.forEach(r=>{
    const aDesc = rowDesc(r.a, r.displayCols); const bDesc = rowDesc(r.b, r.displayCols);
    rows.push([r.key.replace(/‖/g,' / '), aDesc, bDesc, r.status, r.aiChecked?'Yes':'No', r.uncertain?'Yes':'No',
      r.status==='MATCH'?aDesc:'', r.status==='MISMATCH'?`A: ${aDesc} | B: ${bDesc}`:'',
      r.status==='A_ONLY'?aDesc:'', r.status==='B_ONLY'?bDesc:'', r.reason||'']);
  });
  const csv = rows.map(r=> r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'diff_ledger_comparison.csv'; a.click();
});
document.getElementById('printBtn').addEventListener('click', ()=> window.print());

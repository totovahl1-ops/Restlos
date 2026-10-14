/* ================= KI-Anbindung (optional) =================
   Anthropic-API-Key eintragen → Rezepte werden live von Claude generiert.
   Leer lassen → lokale Rezept-Datenbank aus data.js.
   ACHTUNG: Ein Key im Frontend ist für jeden Besucher sichtbar. Nur lokal nutzen
   oder den fetch in aiRecipes() auf ein eigenes Backend/Proxy umbiegen. */
const AI_CONFIG = { apiKey: '', model: 'claude-sonnet-5-5' };

/* ================= Helfer ================= */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const wait = ms => new Promise(r => setTimeout(r, ms));

const canon = name => ALIASES[name] || name;
// „Tomate“ = „Tomaten“, „Ei“ = „Eier“ – ponytail: Plural-Heuristik, echtes Stemming falls nötig
function same(a, b) {
  a = canon(a).toLowerCase().trim(); b = canon(b).toLowerCase().trim();
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length > 1 && l.startsWith(s) && l.length - s.length <= 2;
}
const entry = name => CATALOG[canon(name)] ?? CATALOG[Object.keys(CATALOG).find(k => same(k, name))] ?? ['🍽️'];
const flags = name => entry(name)[1] || '';
const emoji = name => entry(name)[0];
const isBasic = name => flags(name).includes('b');

const STATUS = {
  frisch: { label: 'frisch', icon: '🌿', cls: 'bg-sage-50 text-sage-800 border-sage-200' },
  dringend: { label: 'muss weg', icon: '⏰', cls: 'bg-amber-50 text-amber-900 border-amber-300' },
  abgelaufen: { label: 'MHD drüber', icon: '⚠️', cls: 'bg-tomato-50 text-tomato-700 border-tomato-200' },
};
const TYPES = {
  match: { icon: '🎯', label: 'Fast 100 % Match', badge: 'bg-white text-sage-800', bg: 'from-sage-100 via-sage-50 to-sage-200' },
  creative: { icon: '✨', label: 'Kreativ ergänzt', badge: 'bg-white text-amber-800', bg: 'from-amber-100 via-orange-50 to-tomato-100' },
  quick: { icon: '⚡', label: 'Schnell & Einfach', badge: 'bg-white text-sky-800', bg: 'from-sky-100 via-cyan-50 to-sage-100' },
  brave: { icon: '🎲', label: 'Ich bin mutig', badge: 'bg-white text-rose-800', bg: 'from-rose-100 via-orange-50 to-amber-100' },
};
const PLAIN = { bg: 'from-sage-50 to-sage-100' };

/* ================= State (LocalStorage) ================= */
const state = {
  pantry: load('rv-pantry', []),       // [{ name, status }]
  diets: load('rv-diets', []),         // z. B. ['vegan', 'glutenfrei']
  excludes: load('rv-excludes', []),
  favorites: load('rv-favs', []),
  shopping: load('rv-shop', []),       // [{ name, qty, from, done }]
  cat: Object.keys(CATEGORIES)[0],
  results: null,                       // null = noch nicht gesucht
  modal: null,                         // { recipe, servings, done: Set }
};
function persist() {
  save('rv-pantry', state.pantry); save('rv-diets', state.diets); save('rv-excludes', state.excludes);
  save('rv-favs', state.favorites); save('rv-shop', state.shopping);
  updateBadges();
}

/* ================= Rezept-Logik ================= */
function allowed(recipe) {
  const banned = state.diets.map(d => DIETS[d]).join('');
  return recipe.ings.every(([n]) => ![...flags(n)].some(f => banned.includes(f)) && !state.excludes.some(x => same(x, n)));
}

// Welche Ernährungsformen erfüllt ein Rezept?
function dietTags(r) {
  const all = r.ings.map(([n]) => flags(n)).join('');
  const has = f => [...f].some(c => all.includes(c));
  return [has('fsmeh') ? !has('fs') && '🥦 vegetarisch' : '🌱 vegan', !has('m') && '🥛 laktosefrei', !has('g') && '🌾 glutenfrei'].filter(Boolean);
}

// Ergänzt ein Rezept um: used (vorhanden), missing (noch benötigt), coverage, score
function analyze(r) {
  const used = [], missing = [];
  for (const [name] of r.ings) {
    const p = state.pantry.find(p => same(p.name, name));
    p ? used.push({ name, status: p.status }) : missing.push({ name, basic: isBasic(name) });
  }
  const coreTotal = r.ings.filter(([n]) => !isBasic(n)).length || 1;
  const coreHave = used.filter(u => !isBasic(u.name)).length;
  const missCore = missing.filter(m => !m.basic).length;
  const urgent = used.reduce((s, u) => s + ({ dringend: 3, abgelaufen: 2 }[u.status] || 0), 0);
  return { ...r, used, missing, missCore, coreHave, urgent, coverage: coreHave / coreTotal,
    score: coreHave * 2 + urgent - missCore * 3 - (missing.length - missCore) * 0.5 };
}

function localRecipes() {
  const pool = RECIPES.filter(allowed).map(analyze).filter(r => r.coreHave > 0);
  const taken = new Set();
  const pick = (list, sort, type) => {
    const r = list.filter(r => !taken.has(r.id)).sort(sort)[0];
    if (r) { taken.add(r.id); return { ...r, type }; }
  };
  const byScore = (a, b) => b.score - a.score;
  // Abdeckung zählt am meisten, aber „muss weg“ kann ein Rezept nach vorne ziehen
  const match = pick(pool, (a, b) => (b.coverage * 10 + b.urgent) - (a.coverage * 10 + a.urgent) || byScore(a, b), 'match');
  const creative = pick(pool.filter(r => r.missCore <= 1), byScore, 'creative') || pick(pool, byScore, 'creative');
  const quick = pick(pool.filter(r => r.time <= 15), byScore, 'quick') || pick(pool, (a, b) => a.time - b.time, 'quick');
  return [match, creative, quick].filter(Boolean);
}

async function aiRecipes() {
  const pantry = state.pantry.map(p => `${p.name} (${STATUS[p.status].label})`).join(', ');
  const prompt = `Du bist Koch und Experte für Resteverwertung. Vorhandene Zutaten: ${pantry}.
Ernährung: ${state.diets.join(', ') || 'keine Einschränkung'}. Niemals verwenden: ${state.excludes.join(', ') || '–'}.
Zutaten mit "muss weg" oder "MHD drüber" bevorzugt verwenden.
Erstelle genau 3 unterschiedliche Rezepte für 2 Portionen:
1. type "match": fast ausschließlich vorhandene Zutaten.
2. type "creative": kreativ, ergänzt höchstens 1–2 Basis-Zutaten (Salz, Öl, Pfeffer, Mehl …).
3. type "quick": unter 15 Minuten Zubereitungszeit.
Antworte NUR mit JSON in genau diesem Format:
{"recipes":[{"type":"match","emoji":"🍝","title":"","desc":"","time":20,"difficulty":"leicht","servings":2,"ings":[["Nudeln",250,"g"],["Salz",null,""]],"steps":["…"]}]}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': AI_CONFIG.apiKey,
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: AI_CONFIG.model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const text = (await res.json()).content[0].text;
  const { recipes } = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return recipes.map((r, i) => analyze({ ...r, id: `ai-${Date.now()}-${i}` }));
}

function braveRecipe() {
  const pool = FRIDGE_STAPLES.filter(s => allowed({ ings: [[s.name]] }));
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a.order - b.order);
  if (pick.length < 3) return null;
  const names = pick.map(p => p.name);
  const list = o => new Intl.ListFormat('de').format(pick.filter(p => p.order === o).map(p => p.name));
  const prep = pick.map(p => `${p.name} ${p.prep}`).join(', ');
  const steps = [prep[0].toUpperCase() + prep.slice(1) + '.', 'Öl in einer großen Pfanne stark erhitzen.'];
  if (list(1)) steps.push(`${list(1)} 5 Minuten kräftig anbraten.`);
  if (list(2)) steps.push(`${list(2)} ${list(1) ? 'zugeben und ' : ''}2–3 Minuten ${list(1) ? 'mit' : ''}braten.`);
  if (list(3)) steps.push(`${list(3)} unterrühren und bei kleiner Hitze stocken bzw. schmelzen lassen.`);
  steps.push('Mit Salz und Pfeffer abschmecken und direkt aus der Pfanne genießen.');
  return {
    id: 'brave-' + names.join('-'), type: 'brave', emoji: '🎲', title: `Blitz-Pfanne mit ${names[0]}, ${names[1]} & ${names[2]}`,
    desc: 'Drei Zufallsfunde aus dem Kühlschrank – in 10 Minuten auf dem Teller.', time: 10, difficulty: 'leicht', servings: 2,
    ings: [...pick.map(p => [p.name, p.amount, p.unit]), ['Öl', 1, 'EL'], ['Salz'], ['Pfeffer']], steps,
  };
}

function fmtAmount(amount, unit, factor) {
  if (amount == null) return 'nach Geschmack';
  let v = amount * factor;
  v = v >= 50 ? Math.round(v / 5) * 5 : v >= 10 ? Math.round(v) : Math.round(v * 2) / 2 || 0.5;
  return `${String(v).replace('.', ',')} ${unit || ''}`.trim();
}

/* ================= Komponenten (geben HTML-Strings zurück) ================= */
const FavButton = (id, on) =>
  `<button data-action="fav" data-id="${esc(id)}" aria-pressed="${on}" aria-label="${on ? 'Aus Favoriten entfernen' : 'Als Favorit speichern'}"
    class="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/90 text-xl shadow-sm transition hover:scale-110 active:scale-90 ${on ? 'pop' : ''}">${on ? '❤️' : '🤍'}</button>`;

const TypeBadge = t => t ? `<span class="badge ${t.badge}">${t.icon} ${t.label}</span>` : '<span></span>';
const DietTags = r => dietTags(r).map(d => `<span class="diet-tag">${d}</span>`).join('');
const MissingTag = m => `<span class="tag-missing">${esc(m.name)}${m.basic ? ' <span class="opacity-60">· Basis</span>' : ''}</span>`;

function RecipeCard(r, i = 0) {
  const t = TYPES[r.type];
  const isFav = state.favorites.some(f => f.id === r.id);
  const rescued = r.used.filter(u => u.status !== 'frisch');
  const pct = Math.round(r.used.length / r.ings.length * 100);
  return `<article class="card fade-up overflow-hidden p-0 transition duration-300 hover:-translate-y-1 hover:shadow-xl" style="animation-delay:${i * 100}ms">
    <div class="relative grid h-36 place-items-center bg-gradient-to-br ${(t || PLAIN).bg}">
      <span class="float select-none text-7xl drop-shadow-md" aria-hidden="true">${esc(r.emoji || '🍽️')}</span>
      <div class="absolute inset-x-3 top-3 flex items-start justify-between">${TypeBadge(t)}${FavButton(r.id, isFav)}</div>
    </div>
    <div class="flex flex-1 flex-col p-5">
      <h3 class="font-display text-xl font-bold leading-snug text-sage-900">${esc(r.title)}</h3>
      <p class="mt-1 text-sm text-sage-600">${esc(r.desc)}</p>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <span class="meta">⏱ ${esc(r.time)} Min.</span><span class="meta">📊 ${esc(r.difficulty)}</span>${DietTags(r)}
      </div>
      <div class="mt-4 flex items-center gap-3">
        <div class="h-2 flex-1 overflow-hidden rounded-full bg-sage-100"><div class="h-full rounded-full bg-gradient-to-r from-sage-400 to-sage-600" style="width:${pct}%"></div></div>
        <span class="text-xs font-extrabold text-sage-700">${r.used.length}/${r.ings.length} da</span>
      </div>
      ${rescued.length ? `<p class="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">🔥 Rettet: ${rescued.map(u => esc(u.name)).join(', ')}</p>` : ''}
      ${r.missing.length
        ? `<p class="mt-3 text-xs font-extrabold uppercase tracking-wider text-tomato-600">Noch benötigt</p><div class="mt-1.5 flex flex-wrap gap-1.5">${r.missing.map(MissingTag).join('')}</div>`
        : '<p class="mt-3 text-sm font-extrabold text-sage-700">🎉 Alles da!</p>'}
      <div class="mt-auto pt-5"><button data-action="open" data-id="${esc(r.id)}" class="btn-primary w-full">Rezept ansehen →</button></div>
    </div>
  </article>`;
}

const Spinner = () => `<div class="card fade-up items-center py-16 text-center">
  <div class="pot" aria-hidden="true"><span class="bubble"></span><span class="bubble"></span><span class="bubble"></span>🍲</div>
  <p class="mt-4 font-display text-2xl font-bold text-sage-900">Kochtopf köchelt …</p>
  <p class="mt-1 text-sm text-sage-600">Wir rühren deine Reste zusammen</p></div>`;

const Empty = (icon, title, text) => `<div class="fade-up rounded-[1.75rem] border-2 border-dashed border-sage-200 bg-white/50 p-10 text-center">
  <div class="text-6xl">${icon}</div><p class="mt-3 font-display text-xl font-bold text-sage-900">${title}</p><p class="mx-auto mt-1 max-w-sm text-sm text-sage-600">${text}</p></div>`;

const Welcome = () => `<div class="card fade-up items-center px-6 py-12 text-center">
  <div class="float flex gap-2 text-5xl" aria-hidden="true"><span>🥕</span><span>🧅</span><span>🍅</span></div>
  <h2 class="mt-5 font-display text-3xl font-extrabold text-sage-900">Kochen statt wegwerfen</h2>
  <p class="mt-2 max-w-md text-sage-600">Sag uns, was noch da ist – wir finden drei Rezepte, die genau das verwerten.</p>
  <ol class="mt-8 grid w-full max-w-xl gap-3 text-left sm:grid-cols-3">
    ${[['🧺', 'Zutaten eintragen', 'oder per Schnellauswahl antippen'], ['⏰', 'Dringendes markieren', 'wird zuerst verkocht'], ['🍳', 'Rezept wählen', 'mit Portionsrechner & Checkliste']]
      .map(([i, t, d], n) => `<li class="rounded-2xl bg-sage-50 p-4 ring-1 ring-sage-100"><span class="text-2xl">${i}</span><p class="mt-1 font-extrabold text-sage-900">${n + 1}. ${t}</p><p class="text-xs text-sage-600">${d}</p></li>`).join('')}
  </ol></div>`;

/* ================= Render ================= */
function renderPantry(fresh) {
  $('#pantry-chips').innerHTML = state.pantry.length
    ? state.pantry.map((p, i) => `<span class="chip ${STATUS[p.status].cls} ${p.name === fresh ? 'pop' : ''}">
        <button data-action="cycle" data-i="${i}" class="py-1 text-left" title="Zustand ändern">${emoji(p.name)} ${esc(p.name)} <span class="font-semibold opacity-70">· ${STATUS[p.status].icon} ${STATUS[p.status].label}</span></button>
        <button data-action="remove" data-i="${i}" class="chip-x" aria-label="${esc(p.name)} entfernen">×</button></span>`).join('')
    : '<p class="w-full rounded-2xl bg-sage-50 p-4 text-center text-sm text-sage-500">🧊 Noch leer – tippe oben eine Zutat ein oder wähle aus der Schnellauswahl.</p>';
  const urgent = state.pantry.filter(p => p.status !== 'frisch').length;
  $('#hero-stats').textContent = state.pantry.length
    ? `${state.pantry.length} Zutat${state.pantry.length > 1 ? 'en' : ''} im Kühlschrank${urgent ? ` · ${urgent} ${urgent > 1 ? 'müssen' : 'muss'} dringend weg` : ''}`
    : 'Trag ein, was noch da ist – wir machen ein Gericht daraus.';
  renderQuick();
}

function renderQuick() {
  $('#cat-tabs').innerHTML = Object.entries(CATEGORIES).map(([name, c]) =>
    `<button data-action="cat" data-cat="${name}" role="tab" aria-selected="${name === state.cat}" class="cat ${name === state.cat ? 'on' : ''}">${c.icon} ${name}</button>`).join('');
  $('#quick-chips').innerHTML = Object.entries(CATEGORIES[state.cat].items).map(([n, [e]]) => {
    const on = state.pantry.some(p => same(p.name, n));
    return `<button data-action="quick" data-name="${n}" aria-pressed="${on}" class="quick ${on ? 'on' : ''}">${e} ${n}</button>`;
  }).join('');
}

function renderDiet() {
  $('#ex-chips').innerHTML = state.excludes.map((x, i) =>
    `<span class="chip pop border-tomato-200 bg-white text-tomato-700">🚫 ${esc(x)}<button data-action="rm-ex" data-i="${i}" class="chip-x" aria-label="${esc(x)} wieder erlauben">×</button></span>`).join('');
  $('#ex-count').textContent = state.excludes.length ? `(${state.excludes.length})` : '';
  const main = state.diets.find(d => d === 'vegan' || d === 'vegetarisch') || '';
  $$('[name=diet-main]').forEach(r => (r.checked = r.value === main));
  $$('[name=diet]').forEach(c => (c.checked = state.diets.includes(c.value)));
}

function renderResults() {
  if (!state.results) return ($('#results').innerHTML = Welcome());
  const active = [...state.diets, ...state.excludes.map(x => 'ohne ' + x)];
  $('#results').innerHTML = state.results.length
    ? `<div class="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div><h2 class="font-display text-3xl font-extrabold text-sage-900">${state.results.length} Ideen für dich</h2>
        <p class="text-sm text-sage-600">${active.length ? 'Gefiltert: ' + esc(active.join(', ')) : 'Sortiert nach Match, Kreativität und Tempo'}</p></div></div>
      <div class="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3">${state.results.map(RecipeCard).join('')}</div>`
    : Empty('🤷', 'Kein passendes Rezept gefunden', 'Ergänze ein paar Zutaten, lockere die Ernährungs-Filter – oder probier „Ich bin mutig“.');
}

function renderFavs() {
  $('#view-favs').innerHTML = `<h2 class="mb-4 font-display text-3xl font-extrabold text-sage-900">❤️ Deine Favoriten</h2>` + (state.favorites.length
    ? `<div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">${state.favorites.map((f, i) => RecipeCard(analyze(f), i)).join('')}</div>`
    : Empty('🤍', 'Noch keine Favoriten', 'Tippe auf das Herz bei einem Rezept, um es hier zu speichern.'));
}

function renderShop() {
  const open = state.shopping.filter(s => !s.done).length;
  $('#view-shop').innerHTML = `<div class="mb-4 flex items-end justify-between gap-2">
      <div><h2 class="font-display text-3xl font-extrabold text-sage-900">🛒 Einkaufsliste</h2><p class="text-sm text-sage-600">${open} offen</p></div>
      ${state.shopping.length ? '<button data-action="shop-share" class="btn-ghost min-h-[42px] text-sm">📤 Teilen</button>' : ''}</div>` +
    (state.shopping.length
      ? `<ul class="card gap-1 p-2">${state.shopping.map((s, i) => `<li class="flex items-center gap-2 rounded-2xl px-3 transition hover:bg-sage-50">
          <label class="flex min-h-[60px] flex-1 cursor-pointer items-center gap-3">
            <input type="checkbox" data-shop="${i}" ${s.done ? 'checked' : ''} class="peer h-6 w-6 accent-sage-600">
            <span class="text-2xl peer-checked:opacity-40">${emoji(s.name)}</span>
            <span class="peer-checked:text-sage-400 peer-checked:line-through"><b>${esc(s.name)}</b> <span class="text-sm text-sage-600">${esc(s.qty)}</span><br><span class="text-xs text-sage-500">für ${esc(s.from)}</span></span>
          </label>
          <button data-action="shop-del" data-i="${i}" class="chip-x" aria-label="${esc(s.name)} löschen">×</button></li>`).join('')}</ul>
        <button data-action="shop-clear" class="btn-ghost mt-3 w-full">✓ Erledigte entfernen</button>`
      : Empty('🧺', 'Liste ist leer', 'Fehlende Zutaten landen hier per Klick aus der Rezeptansicht.'));
}

/* ----- RecipeModal ----- */
function openModal(recipe) {
  state.modal = { recipe: analyze(recipe), servings: recipe.servings, done: new Set() };
  renderModal();
  $('#modal').showModal();
  $('#modal').scrollTop = 0;
}

function ModalIngredients() {
  const { recipe: r, servings } = state.modal;
  const f = servings / r.servings;
  return r.ings.map(([name, amount, unit]) => {
    const miss = r.missing.find(m => m.name === name);
    return `<li class="flex items-center justify-between gap-3 border-b border-sage-100 py-3 last:border-0">
      <span class="flex flex-wrap items-center gap-2 font-bold"><span class="text-xl">${emoji(name)}</span>${esc(name)}
        ${miss ? `<span class="tag-missing">Noch benötigt${miss.basic ? ' · Basis' : ''}</span>` : '<span class="text-sage-500" aria-label="vorhanden">✓</span>'}</span>
      <span class="shrink-0 font-semibold text-sage-700">${esc(fmtAmount(amount, unit, f))}</span></li>`;
  }).join('');
}

function StepProgress() {
  const { recipe: r, done } = state.modal;
  return `<span class="text-sm font-bold text-sage-600">${done.size}/${r.steps.length} erledigt${done.size === r.steps.length ? ' 🎉' : ''}</span>`;
}

function renderModal() {
  const { recipe: r, servings, done } = state.modal;
  const t = TYPES[r.type];
  $('#modal').innerHTML = `
  <div class="relative bg-gradient-to-br ${(t || PLAIN).bg} px-5 pb-10 pt-4">
    <div class="flex items-start justify-between gap-2">${TypeBadge(t)}
      <div class="flex gap-2">${FavButton(r.id, state.favorites.some(f => f.id === r.id))}
        <button data-action="close" class="grid h-11 w-11 place-items-center rounded-full bg-white/90 text-2xl shadow-sm" aria-label="Schließen">×</button></div>
    </div>
    <div class="float mt-2 select-none text-center text-8xl drop-shadow-lg" aria-hidden="true">${esc(r.emoji || '🍽️')}</div>
  </div>
  <div class="relative -mt-6 space-y-5 rounded-t-[2rem] bg-cream px-5 pb-8 pt-6">
    <div>
      <h2 class="font-display text-3xl font-extrabold leading-tight text-sage-900">${esc(r.title)}</h2>
      <p class="mt-1 text-sage-600">${esc(r.desc)}</p>
      <div class="mt-3 flex flex-wrap gap-1.5"><span class="meta">⏱ ${esc(r.time)} Min.</span><span class="meta">📊 ${esc(r.difficulty)}</span>${DietTags(r)}</div>
    </div>

    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="h3">Zutaten</h3>
        <div class="flex items-center gap-1 rounded-full bg-sage-50 p-1 ring-1 ring-sage-200">
          <button data-action="srv" data-d="-1" class="grid h-10 w-10 place-items-center rounded-full bg-white text-xl font-bold shadow-sm active:scale-90" aria-label="Weniger Portionen">−</button>
          <span id="srv" class="min-w-[6.5rem] text-center text-sm font-extrabold" aria-live="polite">${servings} Portion${servings > 1 ? 'en' : ''}</span>
          <button data-action="srv" data-d="1" class="grid h-10 w-10 place-items-center rounded-full bg-white text-xl font-bold shadow-sm active:scale-90" aria-label="Mehr Portionen">+</button>
        </div>
      </div>
      <ul id="modal-ings" class="mt-2">${ModalIngredients()}</ul>
      ${r.missing.length ? `<button data-action="add-missing" class="btn-accent mt-3 w-full">🛒 Fehlende auf die Einkaufsliste (${r.missing.length})</button>` : ''}
    </div>

    <div class="card">
      <div class="flex items-center justify-between"><h3 class="h3">Zubereitung</h3><span id="step-progress">${StepProgress()}</span></div>
      <ol class="mt-3 space-y-2">${r.steps.map((s, i) => `<li><label class="flex cursor-pointer gap-3 rounded-2xl bg-sage-50/60 p-4 ring-1 ring-sage-100 transition hover:bg-sage-50 has-[:checked]:bg-white has-[:checked]:opacity-60">
        <input type="checkbox" data-step="${i}" ${done.has(i) ? 'checked' : ''} class="peer mt-0.5 h-6 w-6 shrink-0 accent-sage-600">
        <span class="peer-checked:line-through"><b class="font-display text-sage-500">${i + 1}.</b> ${esc(s)}</span></label></li>`).join('')}</ol>
    </div>
  </div>`;
}

function updateBadges() {
  const set = (cls, n) => $$(cls).forEach(el => { el.classList.toggle('hidden', !n); el.textContent = n; });
  set('.badge-favs', state.favorites.length);
  set('.badge-shop', state.shopping.filter(s => !s.done).length);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ================= Aktionen ================= */
const currentStatus = () => $('[name=status]:checked').value;

function addIngredient(raw, status = 'frisch') {
  let last;
  for (let name of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    name = name[0].toUpperCase() + name.slice(1);
    const ex = state.pantry.find(p => same(p.name, name));
    ex ? (ex.status = status) : state.pantry.push({ name, status });
    last = ex ? ex.name : name;
  }
  persist(); renderPantry(last);
}

async function find() {
  if (!state.pantry.length) return toast('Füge zuerst ein paar Zutaten hinzu 🥕');
  $('#results').innerHTML = Spinner();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    state.results = AI_CONFIG.apiKey ? await aiRecipes() : (await wait(1100), localRecipes());
  } catch (e) {
    console.error(e);
    toast('KI nicht erreichbar – nutze lokale Rezepte');
    state.results = localRecipes();
  }
  renderResults();
}

const base = ({ id, type, emoji, title, desc, time, difficulty, servings, ings, steps }) => ({ id, type, emoji, title, desc, time, difficulty, servings, ings, steps });
const findById = id => [state.modal?.recipe, ...(state.results || []), ...state.favorites].find(r => r?.id === id);

function toggleFav(id) {
  const i = state.favorites.findIndex(f => f.id === id);
  if (i >= 0) state.favorites.splice(i, 1);
  else state.favorites.push(base(findById(id)));
  const on = i < 0;
  persist();
  toast(on ? '❤️ Als Favorit gespeichert' : 'Aus Favoriten entfernt');
  $$(`[data-action=fav][data-id="${CSS.escape(id)}"]`).forEach(b => (b.outerHTML = FavButton(id, on)));
  if (!$('#view-favs').hidden) renderFavs();
}

function addMissing() {
  const { recipe: r, servings } = state.modal;
  let n = 0;
  for (const m of r.missing) {
    if (state.shopping.some(s => !s.done && same(s.name, m.name))) continue;
    const [, amount, unit] = r.ings.find(([x]) => x === m.name);
    state.shopping.push({ name: m.name, qty: fmtAmount(amount, unit, servings / r.servings), from: r.title, done: false });
    n++;
  }
  persist();
  toast(n ? `🛒 ${n} Zutat${n > 1 ? 'en' : ''} auf die Einkaufsliste gesetzt` : 'Steht schon alles auf der Liste ✓');
}

function showView(v) {
  for (const s of ['cook', 'favs', 'shop']) $(`#view-${s}`).hidden = s !== v;
  $$('[data-action=view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'favs') renderFavs();
  if (v === 'shop') renderShop();
  scrollTo({ top: 0, behavior: 'smooth' });
}

const ACTIONS = {
  quick: el => {
    const i = state.pantry.findIndex(p => same(p.name, el.dataset.name));
    i >= 0 ? (state.pantry.splice(i, 1), persist(), renderPantry()) : addIngredient(el.dataset.name, currentStatus());
  },
  cat: el => { state.cat = el.dataset.cat; renderQuick(); },
  cycle: el => {
    const p = state.pantry[el.dataset.i], keys = Object.keys(STATUS);
    p.status = keys[(keys.indexOf(p.status) + 1) % keys.length];
    persist(); renderPantry(p.name);
  },
  remove: el => { state.pantry.splice(el.dataset.i, 1); persist(); renderPantry(); },
  'clear-pantry': () => { if (state.pantry.length && confirm('Alle Zutaten entfernen?')) { state.pantry = []; persist(); renderPantry(); } },
  'rm-ex': el => { state.excludes.splice(el.dataset.i, 1); persist(); renderDiet(); },
  find,
  brave: () => { const r = braveRecipe(); r ? openModal(r) : toast('Zu viele Ausschlüsse für den Zufall 😅'); },
  open: el => openModal(findById(el.dataset.id)),
  fav: el => toggleFav(el.dataset.id),
  close: () => $('#modal').close(),
  srv: el => {
    const m = state.modal;
    m.servings = Math.min(12, Math.max(1, m.servings + +el.dataset.d));
    $('#srv').textContent = `${m.servings} Portion${m.servings > 1 ? 'en' : ''}`;
    $('#modal-ings').innerHTML = ModalIngredients();
  },
  'add-missing': addMissing,
  view: el => showView(el.dataset.view),
  'shop-del': el => { state.shopping.splice(el.dataset.i, 1); persist(); renderShop(); },
  'shop-clear': () => { state.shopping = state.shopping.filter(s => !s.done); persist(); renderShop(); },
  'shop-share': async () => {
    const text = 'Einkaufsliste:\n' + state.shopping.filter(s => !s.done).map(s => `• ${s.name} (${s.qty})`).join('\n');
    try {
      if (navigator.share) await navigator.share({ title: 'Einkaufsliste', text });
      else { await navigator.clipboard.writeText(text); toast('📋 Liste kopiert'); }
    } catch {}
  },
};

/* ================= Events ================= */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) ACTIONS[el.dataset.action]?.(el);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.step) {
    t.checked ? state.modal.done.add(+t.dataset.step) : state.modal.done.delete(+t.dataset.step);
    $('#step-progress').innerHTML = StepProgress();
  }
  if (t.dataset.shop) { state.shopping[t.dataset.shop].done = t.checked; persist(); renderShop(); }
  if (t.name === 'diet' || t.name === 'diet-main') {
    state.diets = [$('[name=diet-main]:checked')?.value, ...[...$$('[name=diet]:checked')].map(c => c.value)].filter(Boolean);
    persist();
    if (state.results && !AI_CONFIG.apiKey) { state.results = localRecipes(); renderResults(); } // Ergebnisse live nachfiltern
  }
});
$('#add-form').addEventListener('submit', e => {
  e.preventDefault();
  addIngredient($('#ing-input').value, currentStatus());
  $('#ing-input').value = '';
});
$('#ex-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#ex-input').value.trim();
  if (v && !state.excludes.some(x => same(x, v))) { state.excludes.push(v); persist(); renderDiet(); }
  $('#ex-input').value = '';
});
$('#modal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ================= Start ================= */
$('#ing-list').innerHTML = [...Object.keys(CATALOG), ...Object.keys(ALIASES)].map(n => `<option value="${n}">`).join('');
renderPantry(); renderDiet(); renderResults(); updateBadges();

// Selbsttest: index.html#test öffnen, Ergebnis in der Konsole
if (location.hash === '#test') {
  const backup = { ...state };
  Object.assign(state, { pantry: [{ name: 'Ei', status: 'frisch' }, { name: 'Tomate', status: 'dringend' }, { name: 'Zwiebel', status: 'frisch' }], diets: [], excludes: [] });
  const res = localRecipes();
  console.assert(res.length === 3 && new Set(res.map(r => r.id)).size === 3, '3 verschiedene Rezepte');
  console.assert(res[0].id === 'shakshuka', 'Match bevorzugt dringende Tomate', res[0].id);
  console.assert(res[2].time <= 15, 'Quick ≤ 15 Min.');
  state.diets = ['vegan'];
  console.assert(localRecipes().every(r => dietTags(r).includes('🌱 vegan')), 'vegan liefert nur vegane Rezepte');
  console.assert(dietTags(RECIPES.find(r => r.id === 'shakshuka'))[0] === '🥦 vegetarisch', 'Shakshuka ist vegetarisch');
  state.diets = []; state.excludes = ['Koriander'];
  console.assert(RECIPES.filter(allowed).every(r => r.id !== 'kichererbsen-curry'), 'Ausschluss greift');
  console.assert(same('Spaghetti', 'Nudeln'), 'Alias Spaghetti → Nudeln');
  console.assert(fmtAmount(250, 'g', 1.5) === '375 g' && fmtAmount(1, 'Stk', 1.5) === '1,5 Stk', 'Portionsrechner');
  Object.assign(state, backup);
  console.log('✅ Selbsttest fertig (Fehler stünden oben als Assertion failed)');
}

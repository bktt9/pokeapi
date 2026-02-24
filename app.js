/* ==========================================================================
   app.js — Pokédex didáctica con PokeAPI
   Tecnologías: HTML + CSS + JavaScript (vanilla)
   --------------------------------------------------------------------------
   Qué vas a aprender aquí (todo comentado):
   - Cómo consumir una API pública con fetch()
   - Paginación (limit/offset) y "cargar más"
   - Búsqueda por nombre/ID
   - Filtro por tipo (agua, fuego, etc.) usando /type
   - Ordenamiento por ID y nombre
   - Render de tarjetas usando <template> y skeletons
   - Buenas prácticas: accesibilidad (aria-*), manejo de errores, caché simple
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------ config / Estado global ----------------------- */
  const API_BASE = 'https://pokeapi.co/api/v2';
  const PAGE_LIMIT = 24;       // cuántos Pokémon por página
  const CONCURRENCY = 12;      // cuántas peticiones de detalle en paralelo

  // Referencias al DOM (tienen que existir en index.html)
  const els = {
    results: document.getElementById('results'),
    tplCard: document.getElementById('pokemon-card-template'),
    tplSkel: document.getElementById('pokemon-card-skeleton'),
    form: document.getElementById('controlsForm'),
    q: document.getElementById('q'),
    typeFilter: document.getElementById('typeFilter'),
    sortBy: document.getElementById('sortBy'),
    btnMore: document.getElementById('loadMore'),
  };

  // Estado de la UI
  const state = {
    mode: 'list',           // 'list' | 'type' | 'search'
    offset: 0,              // para paginación de /pokemon
    limit: PAGE_LIMIT,
    hasMore: true,          // si hay más para "cargar más"
    currentQ: '',
    currentType: '',
    currentSort: 'id-asc',
    // Para modo "type": PokeAPI /type devuelve TODO el catálogo; paginamos localmente
    typeCatalog: [],        // [{ name, url }]
    typeCursor: 0,
  };

  // Caché sencilla en memoria para no pedir el mismo detalle muchas veces
  const cache = new Map(); // key: name|id -> pokemonDetail

  /* -----------------------------  Init ----------------------------------- */
  bindUI();
  init();

  async function init(){
    try{
      await loadTypesIntoSelect();   // Poblar <select> de tipos
      await runQueryFromControls();  // Cargar primera página por defecto
    }catch(err){
      showError('No se pudo inicializar la aplicación. Revisa tu conexión.');
      console.error(err);
    }
  }

  /* ------------------------Eventos de la interfaz ----------------------- */
  function bindUI(){
    // Enviar filtros/búsqueda
    els.form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      runQueryFromControls();
    });

    // Botón "Cargar más"
    els.btnMore.addEventListener('click', () => loadMorePage());

    // Accesibilidad: al cambiar sort sin enviar el form, aplicamos (opcional)
    els.sortBy.addEventListener('change', () => {
      // Re-ejecutamos consulta con el nuevo orden
      runQueryFromControls();
    });
  }

  /* --------------------- Leer controles y ejecutar query ----------------- */
  async function runQueryFromControls(){
    // Normalizamos valores del form
    state.currentQ = (els.q.value || '').trim().toLowerCase();
    state.currentType = (els.typeFilter.value || '').trim().toLowerCase();
    state.currentSort = els.sortBy.value || 'id-asc';

    // Determinamos el "modo" según los controles:
    // - search: si hay q (nombre/ID). Mostramos 1 resultado (si existe).
    // - type: si NO hay q pero sí type.
    // - list: ni q ni type -> /pokemon?limit&offset
    if(state.currentQ){
      state.mode = 'search';
    }else if(state.currentType){
      state.mode = 'type';
    }else{
      state.mode = 'list';
    }

    // Reseteamos estado de paginación y UI
    state.offset = 0;
    state.typeCatalog = [];
    state.typeCursor = 0;
    state.hasMore = true;
    clearGrid();

    // Ejecutamos la primera "página" del modo actual
    await loadMorePage(true);
  }

  /* -------------------------- Cargar una página ------------------------- */
  async function loadMorePage(isFirstPage = false){
    try{
      setBusy(true);
      // Mostramos skeletons solo en la primera carga de cada tanda
      if(isFirstPage){
        renderSkeletons(state.mode === 'search' ? 1 : state.limit);
      }

      let batch = [];
      if(state.mode === 'list'){
        batch = await fetchListPage(state.offset, state.limit);
        state.offset += state.limit;
        state.hasMore = batch.length === state.limit; // si vino "página llena", seguramente hay más
      }else if(state.mode === 'type'){
        // Si es la primera vez en modo type, pedimos el catálogo de ese tipo
        if(state.typeCatalog.length === 0){
          state.typeCatalog = await fetchTypeCatalog(state.currentType); // lista TOTAL para ese tipo
          state.typeCursor = 0;
        }
        // Cortamos la "página" localmente
        const slice = state.typeCatalog.slice(state.typeCursor, state.typeCursor + state.limit);
        state.typeCursor += slice.length;
        state.hasMore = state.typeCursor < state.typeCatalog.length;
        // Pedimos detalles de ese slice
        batch = await fetchManyDetails(slice.map(x => x.name));
      }else if(state.mode === 'search'){
        const poke = await fetchDetailSafely(state.currentQ);
        // Si además el usuario seleccionó un tipo, validamos que coincida
        if(poke && state.currentType){
          const hasType = poke.types.some(t => t.type.name === state.currentType);
          if(!hasType){
            // No coincide con el tipo -> mostramos vacío y mensaje
            batch = [];
            showInfo(`“${state.currentQ}” no es de tipo “${state.currentType}”.`);
          }else{
            batch = [poke];
          }
        }else{
          batch = poke ? [poke] : [];
        }
        state.hasMore = false; // búsqueda puntual no tiene paginación
      }

      // Si no llegaron resultados reales, limpiamos skeletons y salimos
      clearSkeletons();
      if(batch.length === 0){
        if(isFirstPage){
          renderEmptyState();
        }
        updateLoadMoreVisibility();
        return;
      }

      // Ordenamos el batch según preferencia del usuario
      batch = sortPokemons(batch, state.currentSort);

      // Pintamos tarjetas
      renderCards(batch);

      updateLoadMoreVisibility();
    }catch(err){
      clearSkeletons();
      showError('Ocurrió un error al cargar datos de PokeAPI.');
      console.error(err);
    }finally{
      setBusy(false);
    }
  }

  /* ----------------------------  Llamadas API ---------------------------- */

  // Página de /pokemon (lista básica con name/url), luego pedimos detalles
  async function fetchListPage(offset, limit){
    const url = `${API_BASE}/pokemon?limit=${limit}&offset=${offset}`;
    const list = await fetchJSON(url);
    const names = (list.results || []).map(x => x.name);
    return fetchManyDetails(names);
  }

  // Catálogo completo por tipo (devuelve TODOS los pokémon de ese tipo)
  async function fetchTypeCatalog(typeName){
    const url = `${API_BASE}/type/${encodeURIComponent(typeName)}`;
    const data = await fetchJSON(url);
    // data.pokemon = [{ pokemon: { name, url }, slot }, ...]
    // Lo normalizamos a { name, url }
    return (data.pokemon || []).map(p => ({
      name: p.pokemon.name,
      url: p.pokemon.url
    }));
  }

  // Detalle seguro: intenta por nombre/ID y devuelve null si no existe
  async function fetchDetailSafely(nameOrId){
    const key = String(nameOrId).toLowerCase().trim();
    if(cache.has(key)) return cache.get(key);
    try{
      const data = await fetchJSON(`${API_BASE}/pokemon/${encodeURIComponent(key)}`);
      cache.set(key, data);
      cache.set(String(data.id), data); // también cacheamos por ID
      cache.set(data.name.toLowerCase(), data); // y por nombre normalizado
      return data;
    }catch{
      return null;
    }
  }

  // Pide muchos detalles con un pool de concurrencia controlada
  async function fetchManyDetails(names){
    const queue = [...names];
    const results = [];
    let active = 0;

    return new Promise((resolve) => {
      const next = () => {
        // Si no quedan tareas y no hay activas, terminamos
        if(queue.length === 0 && active === 0){
          resolve(results);
          return;
        }
        // Lanzamos más tareas mientras tengamos cupo
        while(active < CONCURRENCY && queue.length > 0){
          const name = queue.shift();
          active++;
          (async () => {
            try{
              const d = await fetchDetailSafely(name);
              if(d) results.push(d);
            }catch(err){
              console.warn('Error detalle:', name, err);
            }finally{
              active--;
              next();
            }
          })();
        }
      };
      next();
    });
  }

  // Cargar lista de tipos y poblar el <select>
  async function loadTypesIntoSelect(){
    const url = `${API_BASE}/type`;
    const data = await fetchJSON(url);
    let types = (data.results || []).map(t => t.name.toLowerCase());

    // Opcional: excluir tipos raros/no jugables (sombreados/unknown)
    const EXCLUDE = new Set(['unknown', 'shadow']);
    types = types.filter(t => !EXCLUDE.has(t)).sort((a,b) => a.localeCompare(b));

    const frag = document.createDocumentFragment();
    for(const t of types){
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = capitalize(t);
      frag.appendChild(opt);
    }
    els.typeFilter.appendChild(frag);
  }

  // fetch JSON con manejo básico de errores HTTP
  async function fetchJSON(url){
    const res = await fetch(url);
    if(!res.ok){
      throw new Error(`HTTP ${res.status} — ${url}`);
    }
    return res.json();
  }

  /* ---------------------------- Render helpers -------------------------- */

  function renderCards(pokemons){
    const frag = document.createDocumentFragment();
    for(const p of pokemons){
      const card = buildCard(p);
      frag.appendChild(card);
    }
    els.results.appendChild(frag);
  }

  function buildCard(detail){
    // detail = respuesta de /pokemon/:id|name
    const node = els.tplCard.content.cloneNode(true);
    const $ = (sel, root=node) => root.querySelector(sel);

    // Imagen oficial (varias rutas posibles; caemos en la que exista)
    const imgUrl =
      detail?.sprites?.other?.['official-artwork']?.front_default ||
      detail?.sprites?.other?.dream_world?.front_default ||
      detail?.sprites?.front_default ||
      // data URI transparente para evitar <img> roto si no hay sprite
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

    const img = $('.card-img');
    img.src = imgUrl;
    img.alt = `Imagen oficial de ${capitalize(detail.name)}`;

    // Nombre + ID (#0001 con padding)
    $('.pokemon-name').textContent = capitalize(detail.name);
    $('.pokemon-id').textContent = `#${String(detail.id).padStart(4,'0')}`;

    // Tipos -> chips con clase modificadora (CSS ya mapea los colores)
    const typesWrap = $('.types');
    for(const t of detail.types){
      const chip = document.createElement('span');
      chip.className = `type-chip type-chip--${t.type.name}`;
      chip.textContent = t.type.name;
      typesWrap.appendChild(chip);
    }

    // Habilidades (abilities)
    const ulAb = $('.ability-list');
    for(const ab of detail.abilities){
      const li = document.createElement('li');
      li.textContent = ab.ability.name;
      ulAb.appendChild(li);
    }

    // Stats (hp, attack, defense, special-attack, special-defense, speed)
    const ulStats = $('.stats-list');
    const ORDER = ['hp','attack','defense','special-attack','special-defense','speed'];
    const map = Object.fromEntries(detail.stats.map(s => [s.stat.name, s.base_stat]));
    for(const key of ORDER){
      const li = document.createElement('li');
      const label = key.replace('-', ' ');
      li.innerHTML = `<span>${label}</span><strong>${map[key] ?? '—'}</strong>`;
      ulStats.appendChild(li);
    }

    return node;
  }

  // Skeletons (placeholders bonitos mientras llegan los datos)
  function renderSkeletons(n){
    const frag = document.createDocumentFragment();
    for(let i=0;i<n;i++){
      frag.appendChild(els.tplSkel.content.cloneNode(true));
    }
    els.results.appendChild(frag);
  }
  function clearSkeletons(){
    els.results.querySelectorAll('.skeleton').forEach(el => el.remove());
  }

  // Estado vacío (cuando no hay resultados)
  function renderEmptyState(){
    const wrap = document.createElement('div');
    wrap.style.padding = '1rem';
    wrap.style.gridColumn = '1 / -1';
    wrap.innerHTML = `
      <p style="text-align:center; color:var(--muted);">
        Sin resultados. Prueba otro nombre/ID, cambia el tipo o quita filtros.
      </p>`;
    els.results.appendChild(wrap);
  }

  // Mostrar/ocultar botón de "cargar más"
  function updateLoadMoreVisibility(){
    els.btnMore.hidden = !state.hasMore;
  }

  // Limpiar grid (para nuevas consultas)
  function clearGrid(){
    els.results.innerHTML = '';
  }

  // Marcar contenedor como ocupado (accesibilidad)
  function setBusy(isBusy){
    els.results.setAttribute('aria-busy', String(!!isBusy));
  }

  // Mensajes simples a la UI
  function showError(msg){
    toast(msg, 'error');
  }
  function showInfo(msg){
    toast(msg, 'info');
  }
  function toast(msg, kind='info'){
    // mensaje simple arriba del grid; minimalista
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.position = 'sticky';
    el.style.top = '0';
    el.style.zIndex = '20';
    el.style.margin = '0 0 .75rem 0';
    el.style.padding = '.6rem .8rem';
    el.style.borderRadius = '10px';
    el.style.border = '1px solid rgba(127,127,127,0.25)';
    el.style.boxShadow = 'var(--shadow)';
    el.style.background = kind === 'error'
      ? 'linear-gradient(180deg, #ffebee, #ffe6e6)'
      : 'linear-gradient(180deg, var(--panel), var(--panel-2))';
    el.style.color = kind === 'error' ? '#a40000' : 'var(--txt)';
    // Insertamos antes del grid
    els.results.parentElement.insertBefore(el, els.results);
    // Auto-desaparece
    setTimeout(() => el.remove(), 3500);
  }

  /* ------------------------------ Utilidades ----------------------------- */

  function sortPokemons(arr, sortBy){
    const out = [...arr];
    switch(sortBy){
      case 'id-asc':
        out.sort((a,b) => a.id - b.id); break;
      case 'id-desc':
        out.sort((a,b) => b.id - a.id); break;
      case 'name-asc':
        out.sort((a,b) => a.name.localeCompare(b.name)); break;
      case 'name-desc':
        out.sort((a,b) => b.name.localeCompare(a.name)); break;
    }
    return out;
  }

  function capitalize(s){
    return (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
  }

})();

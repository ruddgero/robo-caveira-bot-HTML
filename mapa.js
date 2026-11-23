// =====================================================================
// MAPA DE CALOR · Indicadores › Ocorrências (tela cheia, líder e admin)
// Carregado só quando o mapa é aberto (junto com leaflet.js / leaflet.css).
// Usa as funções do app.js: el, api, aviso, S, COR_TIPO, MESES_ABREV, abrirRoi, ehAdmin, ehLider.
// =====================================================================
const MapaCalor = (() => {
  const ATRIBUICAO = 'Imagens: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
  let M = null;           // estado da tela aberta
  const limites = a => L.latLngBounds([a.s, a.w], [a.n, a.e]);

  // ------------------- camada de calor (canvas próprio, sem plugin) -------------------
  const PALETA = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 1;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 256, 0);
    [[0, 'rgba(0,0,255,0)'], [0.25, '#2b6cff'], [0.45, '#00e5ff'], [0.6, '#3cff3c'], [0.78, '#ffee00'], [1, '#ff1e1e']].forEach(([p, cor]) => g.addColorStop(p, cor));
    x.fillStyle = g; x.fillRect(0, 0, 256, 1);
    return x.getImageData(0, 0, 256, 1).data;
  })();
  const CamadaCalor = L.Layer.extend({
    initialize(pontos) { this._pontos = pontos; },
    definir(pontos) { this._pontos = pontos; this._desenhar(); },
    onAdd(map) {
      this._map = map;
      this._c = L.DomUtil.create('canvas', 'mapa-calor-canvas leaflet-zoom-hide');
      map.getPanes().overlayPane.appendChild(this._c);
      map.on('moveend zoomend resize viewreset', this._desenhar, this);
      this._desenhar();
    },
    onRemove(map) { L.DomUtil.remove(this._c); map.off('moveend zoomend resize viewreset', this._desenhar, this); },
    _desenhar() {
      const map = this._map; if (!map) return;
      const tam = map.getSize(), c = this._c;
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      c.width = tam.x; c.height = tam.y;
      const x = c.getContext('2d');
      x.clearRect(0, 0, tam.x, tam.y);
      if (!this._pontos.length) return;
      const max = Math.max(...this._pontos.map(p => p.peso));
      // raio de ~150 m no chão (acompanha o zoom), entre 26 e 160 px
      const lat = map.getCenter().lat, mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** map.getZoom();
      const raio = Math.max(26, Math.min(160, 150 / mpp));
      for (const p of this._pontos) {
        const q = map.latLngToContainerPoint([p.lat, p.lng]);
        const r = raio * (0.75 + 0.5 * p.peso / max);
        const a = 0.35 + 0.65 * p.peso / max;
        const g = x.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
        g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g; x.beginPath(); x.arc(q.x, q.y, r, 0, Math.PI * 2); x.fill();
      }
      const img = x.getImageData(0, 0, tam.x, tam.y), d = img.data;
      for (let i = 3; i < d.length; i += 4) {
        const al = d[i]; if (!al) continue;
        const k = al * 4;
        d[i - 3] = PALETA[k]; d[i - 2] = PALETA[k + 1]; d[i - 1] = PALETA[k + 2]; d[i] = Math.min(235, al * 1.4);
      }
      x.putImageData(img, 0, 0);
    }
  });

  // ------------------- abrir / fechar -------------------
  function abrir() {
    if (M) return;
    const tela = el('div', { class: 'mapa-tela', role: 'dialog', 'aria-label': 'Mapa de calor' });
    document.body.append(tela);
    document.body.style.overflow = 'hidden';
    M = { tela, modo: 'calor', contornosVisiveis: true, ano: S.indAno || 0, mes: S.indMes || 0, tipos: (S.indTipos || []).slice(), sel: '', selArea: '', marcando: null, desenho: null, d: null };
    history.pushState({ mapaCalor: true }, '');
    window.addEventListener('popstate', aoVoltar);
    document.addEventListener('keydown', aoTeclar);
    montar();
    carregar();
  }
  function fechar(doHistorico) {
    if (!M) return;
    window.removeEventListener('popstate', aoVoltar);
    document.removeEventListener('keydown', aoTeclar);
    if (M.map) M.map.remove();
    M.tela.remove(); M = null;
    document.body.style.overflow = '';
    if (!doHistorico && history.state && history.state.mapaCalor) history.back();
  }
  function aoVoltar() { if (modalAberto()) { history.pushState({ mapaCalor: true }, ''); fecharModal(); return; } fechar(true); }
  function aoTeclar(e) {
    if (e.key !== 'Escape' || modalAberto()) return;
    if (M.desenho) return pararDesenho();
    if (M.marcando) return pararMarcacao();
    if (gavetaAberta()) return gaveta(false);
    fechar();
  }

  // ------------------- estrutura da tela -------------------
  function montar() {
    const t = M.tela;
    M.titulo = el('div', { class: 'mapa-sub mudo pequeno' });
    M.filtros = el('div', { class: 'mapa-filtros' });
    M.caixaMapa = el('div', { class: 'mapa-mapa' });
    M.lado = el('aside', { class: 'mapa-lado' });
    M.faixa = el('div', { class: 'mapa-faixa', hidden: true });
    M.btModo = el('div', { class: 'mapa-modo' },
      el('button', { class: 'ativo', 'data-modo': 'calor', onclick: () => trocarModo('calor') }, 'Calor'),
      ehAdmin() ? el('button', { 'data-modo': 'areas', onclick: () => trocarModo('areas') }, 'Áreas') : null,
      el('button', { 'data-modo': 'locais', onclick: () => trocarModo('locais') }, 'Locais'));
    t.replaceChildren(
      el('header', { class: 'mapa-topo' },
        el('button', { class: 'btn pequeno', onclick: () => fechar() }, '‹ Voltar'),
        el('div', { class: 'mapa-tit' }, el('strong', { text: 'Mapa de calor' }), M.titulo),
        el('div', { class: 'mapa-acoes' }, M.btModo,
          ehAdmin() ? (M.btContornos = el('button', { class: 'btn-icone ativo', title: 'Mostrar/esconder os contornos das áreas (só o admin vê)', 'aria-label': 'Mostrar ou esconder os contornos das áreas', 'aria-pressed': 'true',
            onclick: () => { M.contornosVisiveis = !M.contornosVisiveis; M.btContornos.classList.toggle('ativo', M.contornosVisiveis); M.btContornos.setAttribute('aria-pressed', String(M.contornosVisiveis)); desenharCamadas(); } }, '▢')) : null,
          el('button', { class: 'btn-icone', title: 'Centralizar na Ferroport', 'aria-label': 'Centralizar na Ferroport', onclick: centralizar }, '⌖'))),
      M.filtros,
      el('div', { class: 'mapa-corpo' }, M.caixaMapa, M.lado),
      M.faixa);

    M.map = L.map(M.caixaMapa, { zoomControl: true, attributionControl: true, minZoom: 13, maxZoom: 19, zoomSnap: 0.5 });
    M.map.attributionControl.setPrefix('Leaflet');
    M.ladrilhos = L.tileLayer('/api/mapa/ladrilho/{z}/{x}/{y}', { maxNativeZoom: 18, maxZoom: 19, minZoom: 13, attribution: ATRIBUICAO, crossOrigin: false }).addTo(M.map);
    M.calor = new CamadaCalor([]).addTo(M.map);
    M.contornos = L.layerGroup().addTo(M.map);
    M.marcas = L.layerGroup().addTo(M.map);
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(M.map);
    M.map.on('click', aoClicarMapa);
    // botão que abre/fecha a gaveta de locais (fica embaixo do + e −)
    const Botao = L.Control.extend({ onAdd: () => {
      M.btGaveta = L.DomUtil.create('button', 'mapa-bt-gaveta');
      M.btGaveta.type = 'button';
      M.btGaveta.setAttribute('aria-expanded', 'false');
      L.DomEvent.disableClickPropagation(M.btGaveta);
      M.btGaveta.addEventListener('click', () => gaveta(!gavetaAberta()));
      return M.btGaveta;
    } });
    new Botao({ position: 'topleft' }).addTo(M.map);
  }
  const gavetaAberta = () => M.tela.classList.contains('lado-aberto');
  function gaveta(abrir) {
    if (abrir && M.btGaveta) {
      const caixa = M.caixaMapa.getBoundingClientRect(), b = M.btGaveta.getBoundingClientRect();
      M.lado.style.setProperty('--topo-menu', Math.round(b.bottom - caixa.top + 6) + 'px');
      M.lado.style.setProperty('--esq-menu', Math.round(b.left - caixa.left) + 'px');
    }
    M.tela.classList.toggle('lado-aberto', abrir);
    if (M.btGaveta) M.btGaveta.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (!abrir && (M.sel || M.selArea)) { M.sel = ''; M.selArea = ''; desenharCamadas(); desenharLado(); }
    rotuloGaveta();
  }
  function rotuloGaveta() {
    if (!M.btGaveta || !M.d) return;
    const n = M.d.pontos.length + M.d.semPosicao.length;
    M.btGaveta.replaceChildren(el('span', { class: 'ic', 'aria-hidden': 'true', text: '☰' }), M.d.areas.length ? `Áreas e locais (${n})` : `Locais (${n})`,
      el('span', { class: 'seta', 'aria-hidden': 'true', text: gavetaAberta() ? '▴' : '▾' }));
    M.btGaveta.title = gavetaAberta() ? 'Fechar a lista' : 'Abrir a lista de áreas e locais';
  }

  async function carregar() {
    const q = new URLSearchParams();
    if (M.ano) q.set('ano', M.ano); if (M.mes) q.set('mes', M.mes);
    if (M.tipos.length) q.set('tipos', M.tipos.join(','));
    try {
      const d = await api('GET', '/api/indicadores/mapa?' + q);
      if (!M) return;
      const primeira = !M.d;
      M.d = d; M.ano = d.ano;
      if (primeira) {
        M.map.setMaxBounds(limites(d.area).pad(0.6));
        M.map.fitBounds(limites(d.area));
      }
      desenhar();
    } catch (e) { aviso(e.message, true); }
  }

  function centralizar() { if (M.d) M.map.flyToBounds(limites(M.d.area), { duration: 0.6 }); }
  function trocarModo(m) {
    M.modo = m;
    M.btModo.querySelectorAll('button').forEach(b => b.classList.toggle('ativo', b.dataset.modo === m));
    desenharCamadas();
  }

  // ------------------- desenho -------------------
  function desenhar() {
    const d = M.d;
    const per = d.mes ? `${MESES_ABREV[d.mes - 1]}/${d.ano}` : `${d.ano} · ano todo`;
    M.titulo.textContent = `${per} · ${d.total} ROI${d.total === 1 ? '' : 's'}${M.tipos.length ? ' · ' + M.tipos.join(', ') : ''}`;
    const chip = (txt, ativo, fn, extra) => el('button', { class: 'filtro' + (ativo ? ' ativo' : ''), onclick: fn }, extra || null, txt);
    const mudar = fn => () => { fn(); carregar(); };
    M.filtros.replaceChildren(...[
      d.anos.length > 1 ? el('div', { class: 'filtros' }, d.anos.slice().sort((a, b) => a - b).map(a => chip(String(a), a === d.ano, mudar(() => { M.ano = a; M.mes = 0; })))) : null,
      el('div', { class: 'filtros' }, chip('Ano todo', !d.mes, mudar(() => { M.mes = 0; })),
        ...d.meses.map(m => chip(MESES_ABREV[m.mes - 1], d.mes === m.mes, mudar(() => { M.mes = d.mes === m.mes ? 0 : m.mes; })))),
      el('div', { class: 'filtros' }, chip('Todos os tipos', !M.tipos.length, mudar(() => { M.tipos = []; })),
        ...Object.keys(d.grupos).map(g => chip(`${g} (${d.tiposTodos[g] || 0})`, M.tipos.includes(g),
          mudar(() => { M.tipos = M.tipos.includes(g) ? M.tipos.filter(x => x !== g) : [...M.tipos, g]; }),
          el('i', { class: 'ponto-tipo', style: `background:${COR_TIPO[g]}` }))))].filter(Boolean));
    desenharCamadas();
    desenharLado();
    rotuloGaveta();
  }

  // ------------------- camadas do mapa -------------------
  const plural = n => `${n} ROI${n === 1 ? '' : 's'}`;
  function corArea(n, max) {
    if (!n) return '#64748b';
    const t = n / max;
    return t > .75 ? '#dc2626' : t > .45 ? '#f97316' : t > .2 ? '#facc15' : '#4ade80';
  }
  function desenharCamadas() {
    const d = M.d; if (!d) return;
    M.calor.definir(M.modo === 'calor' ? d.pontos.filter(p => p.total).map(p => ({ lat: p.lat, lng: p.lng, peso: p.total })) : []);
    // contornos das áreas
    M.contornos.clearLayers();
    const maxA = Math.max(1, ...d.areas.map(a => a.total));
    // a delimitação das áreas fica oculta: só o administrador vê e edita
    const verContornos = ehAdmin() && (M.contornosVisiveis || M.modo === 'areas' || M.desenho);
    for (const a of verContornos ? d.areas : []) {
      const sel = M.selArea === a.id, pintar = M.modo === 'areas';
      const pol = L.polygon(a.poly, pintar
        ? { color: sel ? '#fff' : '#e2e8f0', weight: sel ? 3 : 1.5, fillColor: corArea(a.total, maxA), fillOpacity: a.total ? .55 : .15, bubblingMouseEvents: false }
        : { color: sel ? '#fff' : '#f97316', weight: sel ? 3 : 2, dashArray: sel ? null : '6 4', fillColor: '#f97316', fillOpacity: sel ? .12 : .04, bubblingMouseEvents: false });
      pol.bindTooltip(`${a.nome} · ${plural(a.total)}`, { permanent: true, direction: 'center', className: 'rotulo-area' });
      pol.on('click', ev => (M.marcando || M.desenho) ? aoClicarMapa(ev) : selecionarArea(a.id, false));
      pol.addTo(M.contornos);
    }
    // pontos: locais (círculo) e estruturas de empresa (losango)
    M.marcas.clearLayers();
    const max = Math.max(1, ...d.pontos.map(p => p.total));
    for (const p of d.pontos) {
      const empresa = p.tipo === 'empresa';
      const dom = Object.entries(p.porTipo).sort((a, b) => b[1] - a[1])[0];
      const grande = M.modo === 'locais' && p.total;
      const tam = grande ? Math.round(26 + 22 * Math.sqrt(p.total / max)) : empresa ? 16 : 14;
      const html = grande ? `<span style="--cor:${COR_TIPO[dom ? dom[0] : 'G6']};width:${tam}px;height:${tam}px">${p.total}</span>` : '<span></span>';
      const classe = 'mapa-bolha' + (empresa ? ' empresa' : '') + (grande ? '' : ' discreta') + (M.sel === p.nome ? ' sel' : '');
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: classe, html, iconSize: [tam, tam] }), title: `${p.nome}${p.empresa ? ' (' + p.empresa + ')' : ''} · ${plural(p.total)}`, keyboard: true })
        .on('click', ev => (M.marcando || M.desenho) ? aoClicarMapa(ev) : selecionar(p.nome, true)).addTo(M.marcas);
    }
    if (M.temp) M.temp.addTo(M.map);
  }

  // ------------------- gaveta -------------------
  function fecharGaveta(soBotao) {
    const bt = el('button', { class: 'btn-icone mapa-fechar', title: 'Fechar', 'aria-label': 'Fechar a lista', onclick: () => gaveta(false) }, '✕');
    return soBotao ? bt : el('div', { class: 'mapa-lado-topo' }, el('span'), bt);
  }
  const voltarLista = () => el('div', { class: 'mapa-lado-topo' },
    el('button', { class: 'btn fantasma pequeno', onclick: () => { M.sel = ''; M.selArea = ''; desenharCamadas(); desenharLado(); } }, '‹ Todas as áreas'),
    fecharGaveta(true));
  const tiposDe = porTipo => el('div', { class: 'mapa-tipos' }, Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([g, n]) =>
    el('span', { class: 'mapa-tipo' }, el('i', { class: 'ponto-tipo', style: `background:${COR_TIPO[g]}` }), `${g} – ${M.d.grupos[g]}: ${n}`)));
  const linhaPonto = (p, comPos, recuo) => el('button', { class: 'mapa-local' + (recuo ? ' recuo' : ''), title: `${p.nome}${p.empresa ? ' (' + p.empresa + ')' : ''} · ${plural(p.total)}`, onclick: () => selecionar(p.nome, comPos) },
    el('span', { class: 'mapa-pino' + (comPos ? '' : ' sem') + (p.tipo === 'empresa' ? ' empresa' : ''), 'aria-hidden': 'true', text: !comPos ? '○' : p.tipo === 'empresa' ? '◆' : '●' }),
    el('span', { class: 'mapa-local-nome', text: p.tipo === 'centro' ? `${p.nome} (meio da área)` : p.nome }),
    el('strong', { text: String(p.total) }));

  function desenharLado() {
    const d = M.d, pode = ehLider();
    if (M.sel) {
      const p = d.pontos.find(x => x.nome === M.sel) || d.semPosicao.find(x => x.nome === M.sel);
      if (p) return M.lado.replaceChildren(...fichaPonto(p, pode).filter(Boolean));
      M.sel = '';
    }
    if (M.selArea) {
      const a = d.areas.find(x => x.id === M.selArea);
      if (a) return M.lado.replaceChildren(...fichaArea(a).filter(Boolean));
      M.selArea = '';
    }
    const ordenar = l => l.slice().sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome));
    const fora = ordenar(d.pontos.filter(p => !p.areaId));
    const busca = el('input', { type: 'search', class: 'mapa-busca', placeholder: 'Buscar área, local ou empresa…', 'aria-label': 'Buscar', oninput: e => {
      const q = semAcento(e.target.value).toLowerCase();
      M.lado.querySelectorAll('.mapa-local').forEach(b => { b.hidden = !!q && !semAcento(b.title).toLowerCase().includes(q); });
    } });
    M.lado.replaceChildren(...[
      el('div', { class: 'mapa-lado-topo' }, busca, fecharGaveta(true)),
      el('h3', { text: `Áreas (${d.areas.length})` }),
      d.areas.length ? el('div', { class: 'mapa-lista' }, d.areas.flatMap(a => [
        el('button', { class: 'mapa-local mapa-area-linha', title: `${a.nome} · ${plural(a.total)}`, onclick: () => selecionarArea(a.id, true) },
          el('span', { class: 'mapa-pino area', 'aria-hidden': 'true', text: '▢' }), el('span', { class: 'mapa-local-nome', text: a.nome }), el('strong', { text: String(a.total) })),
        ...ordenar(d.pontos.filter(p => p.areaId === a.id)).map(p => linhaPonto(p, true, true))]))
        : el('p', { class: 'mudo pequeno', style: 'margin:0', text: ehAdmin() ? 'Nenhuma área desenhada ainda. Use "✏️ Desenhar área" abaixo.' : 'Nenhuma área desenhada ainda.' }),
      fora.length ? el('h3', { text: d.areas.length ? `Fora das áreas (${fora.length})` : `Locais no mapa (${fora.length})` }) : null,
      fora.length ? el('div', { class: 'mapa-lista' }, fora.map(p => linhaPonto(p, true))) : null,
      d.semPosicao.length ? el('h3', { text: `Sem posição no mapa (${d.semPosicao.length})` }) : null,
      d.semPosicao.length ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: pode ? 'Toque no local e marque onde ele fica. Os ROIs dele passam a aparecer no calor.' : 'Ainda não aparecem no calor.' }) : null,
      d.semPosicao.length ? el('div', { class: 'mapa-lista' }, d.semPosicao.map(p => linhaPonto(p, false))) : null,
      pode ? el('div', { class: 'mapa-ferramentas' },
        el('button', { class: 'btn pequeno', onclick: novoPonto }, '➕ Novo ponto (local ou empresa)'),
        ehAdmin() ? el('button', { class: 'btn pequeno', onclick: () => iniciarDesenho() }, '✏️ Desenhar área') : null,
        ehAdmin() ? el('button', { class: 'btn pequeno', onclick: () => { fechar(); setTimeout(abrirLocaisIndicador, 50); } }, '🔤 Padronizar nomes') : null) : null,
      el('p', { class: 'mudo pequeno mapa-legenda-lista', style: 'margin:0' }, '▢ área · ● local · ◆ estrutura de empresa · ○ sem posição'),
      ehAdmin() ? el('details', { class: 'mapa-admin' },
        el('summary', { text: 'Enquadramento do mapa (admin)' }),
        el('p', { class: 'mudo pequeno', style: 'margin:0', text: d.areaPadrao ? 'Usando o enquadramento padrão (terminal, ADM, ponte e píeres).' : 'Usando o enquadramento salvo pelo administrador.' }),
        el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' },
          el('button', { class: 'btn pequeno', onclick: salvarEnquadramento }, 'Salvar esta vista'),
          d.areaPadrao ? null : el('button', { class: 'btn fantasma pequeno', onclick: () => salvarEnquadramento(null) }, 'Voltar ao padrão'))) : null].filter(Boolean));
  }

  function porEmpresa(x) {
    const lista = Object.entries(x.porEmpresa || {}).sort((a, b) => b[1] - a[1]);
    if (!lista.length) return null;
    const max = lista[0][1];
    return el('div', { class: 'mapa-empresas' }, lista.slice(0, 12).map(([nome, n]) => el('div', { class: 'mapa-empresa' },
      el('span', { class: 'mapa-local-nome', text: nome, title: nome }), el('i', { style: `width:${Math.max(6, n / max * 100)}%` }), el('strong', { text: String(n) }))),
      lista.length > 12 ? el('div', { class: 'mudo pequeno', text: `+ ${lista.length - 12} empresas` }) : null);
  }

  function listaRois(p) {
    return [
      p.rois.length ? el('div', { class: 'mapa-lista' }, p.rois.map(r => el('button', { class: 'mapa-roi', onclick: () => abrirRoi(r.id) },
        el('span', { class: 'ponto-tipo', style: `background:${COR_TIPO[r.tipo] || '#888'}` }),
        el('span', { style: 'min-width:0' },
          el('div', { class: 'tit' }, `ROI ${r.numero} · ${r.tipo} · ${r.data}`, r.simulado ? el('span', { class: 'etiqueta simulado', text: 'SIMULADO' }) : null),
          el('div', { class: 'sub', text: [r.local !== p.nome ? r.local : '', r.empresa, r.descricao].filter(Boolean).join(' · ') }))))) : el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhum ROI neste período.' }),
      p.rois.length < p.total ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `Mostrando ${p.rois.length} de ${p.total}.` }) : null];
  }

  function fichaPonto(p, pode) {
    const temPos = 'lat' in p, empresa = p.tipo === 'empresa', centro = p.tipo === 'centro';
    const sub = centro ? 'Meio da área: o local é a própria área e ainda não tem ponto próprio'
      : [temPos ? (empresa ? 'Estrutura de empresa' : 'Local') : 'Sem posição no mapa', p.empresa, p.area ? `área ${p.area}` : temPos && M.d.areas.length ? 'fora das áreas' : ''].filter(Boolean).join(' · ');
    return [
      voltarLista(),
      el('div', {}, el('h3', { class: 'mapa-ficha-tit', text: p.nome }), el('div', { class: 'mudo pequeno', text: sub })),
      el('div', { class: 'mapa-kpi' }, el('strong', { text: String(p.total) }), el('span', { text: `ROI${p.total === 1 ? '' : 's'} no período` })),
      p.total ? tiposDe(p.porTipo) : null,
      p.simulados ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `${p.simulados} simulado${p.simulados === 1 ? '' : 's'} (contam no total).` }) : null,
      !empresa && Object.keys(p.porEmpresa || {}).length ? el('h3', { text: 'Por empresa' }) : null,
      !empresa ? porEmpresa(p) : null,
      ...listaRois(p),
      pode ? el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn primario pequeno', onclick: () => iniciarMarcacao(p.nome) }, centro ? '📍 Marcar ponto próprio' : temPos ? '📍 Mudar posição' : '📍 Marcar no mapa'),
        temPos && !centro ? el('button', { class: 'btn pequeno', onclick: () => editarTipo(p) }, empresa ? 'Editar empresa' : 'É estrutura de empresa?') : null,
        temPos && !centro ? el('button', { class: 'btn fantasma pequeno', onclick: () => removerPosicao(p.nome) }, 'Tirar do mapa') : null) : null
    ];
  }

  function fichaArea(a) {
    const dentro = M.d.pontos.filter(p => p.areaId === a.id).sort((x, y) => y.total - x.total || x.nome.localeCompare(y.nome));
    const parte = M.d.total ? Math.round(a.total / M.d.total * 100) : 0;
    return [
      voltarLista(),
      el('div', {}, el('h3', { class: 'mapa-ficha-tit', text: a.nome }), el('div', { class: 'mudo pequeno', text: (n => `Área · ${n} ponto${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'}`)(dentro.filter(p => p.tipo !== 'centro').length) })),
      el('div', { class: 'mapa-kpis' },
        el('div', { class: 'mapa-kpi' }, el('strong', { text: String(a.total) }), el('span', { text: `ROI${a.total === 1 ? '' : 's'} no período` })),
        el('div', { class: 'mapa-kpi' }, el('strong', { text: parte + '%' }), el('span', { text: 'do total do período' }))),
      a.total ? tiposDe(a.porTipo) : null,
      Object.keys(a.porEmpresa || {}).length ? el('h3', { text: 'Por empresa' }) : null,
      porEmpresa(a),
      el('h3', { text: 'Locais e empresas na área' }),
      dentro.length ? el('div', { class: 'mapa-lista' }, dentro.map(p => linhaPonto(p, true))) : el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhum ponto marcado dentro desta área.' }),
      ehAdmin() ? el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn pequeno', onclick: () => renomearArea(a) }, 'Renomear'),
        el('button', { class: 'btn pequeno', onclick: () => iniciarDesenho(a) }, 'Redesenhar'),
        el('button', { class: 'btn fantasma pequeno', onclick: () => apagarArea(a) }, 'Apagar área')) : null
    ];
  }

  function selecionar(nome, voar) {
    M.sel = nome; M.selArea = '';
    const p = M.d.pontos.find(x => x.nome === nome);
    if (voar && p) M.map.flyTo([p.lat, p.lng], Math.max(M.map.getZoom(), 17), { duration: 0.6 });
    desenharCamadas(); desenharLado();
    gaveta(true);
  }
  function selecionarArea(id, voar) {
    M.selArea = id; M.sel = '';
    const a = M.d.areas.find(x => x.id === id);
    if (voar && a) M.map.flyToBounds(L.latLngBounds(a.poly), { duration: 0.6, padding: [40, 40] });
    desenharCamadas(); desenharLado();
    gaveta(true);
  }

  // ------------------- faixa de instruções -------------------
  function faixa(...filhos) { M.faixa.hidden = false; M.faixa.replaceChildren(...filhos); }
  function semFaixa() { M.faixa.hidden = true; M.faixa.replaceChildren(); }
  const botaoFaixa = (txt, fn, primario) => el('button', { class: 'btn pequeno' + (primario ? ' primario' : ' fantasma'), onclick: fn }, txt);

  // ------------------- marcar ponto (líder e admin) -------------------
  function iniciarMarcacao(nome, extra = {}) {
    pararDesenho();
    M.marcando = { nome, ...extra };
    M.tela.classList.add('marcando');
    gaveta(false);
    faixa(el('span', {}, 'Toque no mapa onde fica ', el('strong', { text: nome })), botaoFaixa('Cancelar', pararMarcacao));
  }
  function pararMarcacao() {
    M.marcando = null; M.tela.classList.remove('marcando'); semFaixa();
    if (M.temp) { M.temp.remove(); M.temp = null; }
  }
  function aoClicarMapa(ev) {
    if (M.desenho) return adicionarVertice(ev.latlng);
    if (!M.marcando) { if (gavetaAberta()) gaveta(false); return; }
    const alvo = M.marcando, { lat, lng } = ev.latlng;
    if (M.temp) M.temp.remove();
    M.temp = L.marker([lat, lng], { icon: L.divIcon({ className: 'mapa-bolha nova' + (alvo.tipo === 'empresa' ? ' empresa' : ''), html: '<span></span>', iconSize: [22, 22] }) }).addTo(M.map);
    faixa(el('span', {}, 'Salvar aqui a posição de ', el('strong', { text: alvo.nome }), '?'),
      el('div', { class: 'linha', style: 'gap:6px' },
        botaoFaixa('Salvar', async () => {
          try {
            await api('PUT', '/api/indicadores/mapa/ponto', { nome: alvo.nome, lat, lng, tipo: alvo.tipo, empresa: alvo.empresa });
            pararMarcacao(); aviso('Posição salva ✓'); M.sel = alvo.nome; M.selArea = ''; await carregar(); gaveta(true);
          } catch (e) { aviso(e.message, true); }
        }, true),
        botaoFaixa('Cancelar', pararMarcacao)));
  }
  async function removerPosicao(nome) {
    try { await api('PUT', '/api/indicadores/mapa/ponto', { nome, lat: null }); aviso('Ponto tirado do mapa'); await carregar(); }
    catch (e) { aviso(e.message, true); }
  }

  // formulário: nome + tipo (local / estrutura de empresa) + empresa
  function formTipo(p, aoConfirmar) {
    const nome = el('input', { type: 'text', maxlength: 80, value: p ? p.nome : '', placeholder: 'Ex.: Canteiro das Contratadas', autofocus: !p });
    if (p) nome.disabled = true;
    const tipo = el('select', {}, el('option', { value: 'local', text: 'Local (portão, prédio, vestiário, via…)' }), el('option', { value: 'empresa', text: 'Estrutura de empresa (canteiro, galpão…)' }));
    tipo.value = p && p.tipo === 'empresa' ? 'empresa' : 'local';
    const empresa = el('input', { type: 'text', maxlength: 80, value: p ? p.empresa || '' : '', placeholder: 'Nome da empresa' });
    const caixaEmp = el('label', { class: 'campo' }, el('span', { text: 'Empresa' }), empresa);
    const atualizar = () => { caixaEmp.hidden = tipo.value !== 'empresa'; };
    tipo.addEventListener('change', atualizar); atualizar();
    abrirModal(p ? `📍 ${p.nome}` : '➕ Novo ponto no mapa', [
      el('label', { class: 'campo' }, el('span', { text: 'Nome do ponto' }), nome),
      el('label', { class: 'campo' }, el('span', { text: 'Tipo' }), tipo),
      caixaEmp,
      p ? null : el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Depois de continuar, toque no mapa onde ele fica. A área é descoberta sozinha pelo contorno.' })
    ], [el('button', { class: 'btn fantasma', 'data-fechar': true, onclick: fecharModal }, 'Cancelar'),
      el('button', { class: 'btn primario', onclick: () => {
        const n = nome.value.trim().replace(/\s+/g, ' ');
        if (!n) return aviso('Informe o nome do ponto.', true);
        if (tipo.value === 'empresa' && !empresa.value.trim()) return aviso('Informe a empresa.', true);
        fecharModal(); aoConfirmar({ nome: n, tipo: tipo.value, empresa: tipo.value === 'empresa' ? empresa.value.trim() : '' });
      } }, p ? 'Salvar' : 'Continuar')]);
  }
  function novoPonto() {
    formTipo(null, x => {
      if (M.d.pontos.some(p => p.nome.toLowerCase() === x.nome.toLowerCase())) return aviso('Já existe um ponto com esse nome no mapa.', true);
      iniciarMarcacao(x.nome, { tipo: x.tipo, empresa: x.empresa });
    });
  }
  function editarTipo(p) {
    formTipo(p, async x => {
      try { await api('PUT', '/api/indicadores/mapa/ponto', { nome: p.nome, lat: p.lat, lng: p.lng, tipo: x.tipo, empresa: x.empresa }); aviso('Ponto atualizado ✓'); await carregar(); }
      catch (e) { aviso(e.message, true); }
    });
  }

  // ------------------- desenhar área (admin) -------------------
  function iniciarDesenho(area) {
    pararMarcacao();
    M.desenho = { area: area || null, pts: [], camada: L.layerGroup().addTo(M.map) };
    M.tela.classList.add('marcando');
    gaveta(false);
    atualizarDesenho();
  }
  function pararDesenho() {
    if (!M.desenho) return;
    M.desenho.camada.remove(); M.desenho = null;
    M.tela.classList.remove('marcando'); semFaixa();
  }
  function adicionarVertice(ll) {
    const pts = M.desenho.pts;
    // tocar perto do primeiro ponto fecha o contorno
    if (pts.length >= 3 && M.map.latLngToContainerPoint(pts[0]).distanceTo(M.map.latLngToContainerPoint(ll)) < 18) return concluirDesenho();
    pts.push([ll.lat, ll.lng]);
    atualizarDesenho();
  }
  function atualizarDesenho() {
    const { pts, camada, area } = M.desenho;
    camada.clearLayers();
    if (pts.length >= 2) L.polygon(pts, { color: '#fff', weight: 2, dashArray: '4 4', fillColor: '#f97316', fillOpacity: .15, interactive: false }).addTo(camada);
    pts.forEach((p, i) => L.circleMarker(p, { radius: i === 0 ? 7 : 5, color: '#fff', weight: 2, fillColor: i === 0 ? '#f97316' : '#0b1120', fillOpacity: 1, interactive: false }).addTo(camada));
    faixa(el('span', {}, area ? 'Redesenhando ' : 'Nova área: ', area ? el('strong', { text: area.nome }) : null, area ? '. ' : '',
      `toque nos cantos (${pts.length} ponto${pts.length === 1 ? '' : 's'}). Para fechar, toque no primeiro ponto ou em Concluir.`),
      el('div', { class: 'linha', style: 'gap:6px' },
        pts.length ? botaoFaixa('Desfazer', () => { pts.pop(); atualizarDesenho(); }) : null,
        pts.length >= 3 ? botaoFaixa('Concluir', concluirDesenho, true) : null,
        botaoFaixa('Cancelar', pararDesenho)));
  }
  function concluirDesenho() {
    const { pts, area } = M.desenho;
    if (pts.length < 3) return aviso('Marque pelo menos 3 cantos.', true);
    const poly = pts.slice();
    if (area) return salvarContorno(area.id, { nome: area.nome, poly });
    pedirNome('Nome da nova área', '', nome => salvarContorno(null, { nome, poly }));
  }
  function pedirNome(titulo, valor, ok) {
    const i = el('input', { type: 'text', maxlength: 60, value: valor, placeholder: 'Ex.: Pátio de Minério', autofocus: true });
    const confirmar = () => { const n = i.value.trim(); if (!n) return aviso('Informe o nome.', true); fecharModal(); ok(n); };
    i.addEventListener('keydown', e => { if (e.key === 'Enter') confirmar(); });
    abrirModal(titulo, [el('label', { class: 'campo' }, el('span', { text: 'Nome' }), i)],
      [el('button', { class: 'btn fantasma', 'data-fechar': true, onclick: fecharModal }, 'Cancelar'), el('button', { class: 'btn primario', onclick: confirmar }, 'Salvar')]);
  }
  async function salvarContorno(id, corpo) {
    try {
      await api(id ? 'PUT' : 'POST', id ? `/api/indicadores/mapa/areas/${encodeURIComponent(id)}` : '/api/indicadores/mapa/areas', corpo);
      pararDesenho();
      aviso(id ? 'Área atualizada ✓' : 'Área criada ✓');
      await carregar();
      const a = M.d.areas.find(x => x.nome === corpo.nome);
      if (a) selecionarArea(a.id, false);
    } catch (e) { aviso(e.message, true); }
  }
  function renomearArea(a) { pedirNome('Renomear área', a.nome, nome => salvarContorno(a.id, { nome })); }
  function apagarArea(a) {
    abrirModal('Apagar área?', [el('p', { text: `A área "${a.nome}" sai do mapa. Os pontos e os ROIs continuam; só deixam de ser somados nesta área.` })],
      [el('button', { class: 'btn fantasma', 'data-fechar': true, onclick: fecharModal }, 'Cancelar'),
        el('button', { class: 'btn perigo', onclick: async () => {
          fecharModal();
          try { await api('DELETE', `/api/indicadores/mapa/areas/${encodeURIComponent(a.id)}`); M.selArea = ''; aviso('Área apagada'); await carregar(); }
          catch (e) { aviso(e.message, true); }
        } }, 'Apagar')]);
  }

  // ------------------- enquadramento (admin) -------------------
  async function salvarEnquadramento(restaurar) {
    const b = M.map.getBounds();
    const area = restaurar === null ? null : { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
    try {
      const r = await api('PUT', '/api/indicadores/mapa/area', { area });
      M.d.area = r.area; M.d.areaPadrao = area === null;
      M.map.setMaxBounds(limites(r.area).pad(0.6));
      if (area === null) centralizar();
      aviso(area === null ? 'Enquadramento padrão restaurado' : 'Enquadramento salvo ✓');
      desenharLado();
    } catch (e) { aviso(e.message, true); }
  }

  return { abrir, fechar };
})();

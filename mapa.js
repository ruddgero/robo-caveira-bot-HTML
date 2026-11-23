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
    M = { tela, modo: 'calor', ano: S.indAno || 0, mes: S.indMes || 0, tipos: (S.indTipos || []).slice(), sel: '', marcando: '', d: null };
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
      el('button', { 'data-modo': 'locais', onclick: () => trocarModo('locais') }, 'Locais'));
    t.replaceChildren(
      el('header', { class: 'mapa-topo' },
        el('button', { class: 'btn pequeno', onclick: () => fechar() }, '‹ Voltar'),
        el('div', { class: 'mapa-tit' }, el('strong', { text: 'Mapa de calor' }), M.titulo),
        el('div', { class: 'mapa-acoes' }, M.btModo,
          el('button', { class: 'btn-icone', title: 'Centralizar na Ferroport', 'aria-label': 'Centralizar na Ferroport', onclick: centralizar }, '⌖'))),
      M.filtros,
      el('div', { class: 'mapa-corpo' }, M.caixaMapa, M.lado),
      M.faixa);

    M.map = L.map(M.caixaMapa, { zoomControl: true, attributionControl: true, minZoom: 13, maxZoom: 19, zoomSnap: 0.5 });
    M.map.attributionControl.setPrefix('Leaflet');
    M.ladrilhos = L.tileLayer('/api/mapa/ladrilho/{z}/{x}/{y}', { maxNativeZoom: 18, maxZoom: 19, minZoom: 13, attribution: ATRIBUICAO, crossOrigin: false }).addTo(M.map);
    M.calor = new CamadaCalor([]).addTo(M.map);
    M.marcas = L.layerGroup().addTo(M.map);
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
    M.tela.classList.toggle('lado-aberto', abrir);
    if (M.btGaveta) M.btGaveta.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (!abrir && M.sel) { M.sel = ''; desenharCamadas(); desenharLado(); }
    rotuloGaveta();
  }
  function rotuloGaveta() {
    if (!M.btGaveta || !M.d) return;
    const n = M.d.pontos.length + M.d.semPosicao.length;
    M.btGaveta.replaceChildren(el('span', { class: 'ic', 'aria-hidden': 'true', text: '☰' }), `Locais (${n})`);
    M.btGaveta.title = gavetaAberta() ? 'Fechar a lista de locais' : 'Abrir a lista de locais';
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
    const mudar = fn => () => { fn(); M.sel = ''; carregar(); };
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

  function desenharCamadas() {
    const d = M.d; if (!d) return;
    M.calor.definir(M.modo === 'calor' ? d.pontos.map(p => ({ lat: p.lat, lng: p.lng, peso: p.total })) : []);
    M.marcas.clearLayers();
    const max = Math.max(1, ...d.pontos.map(p => p.total));
    for (const p of d.pontos) {
      const dom = Object.entries(p.porTipo).sort((a, b) => b[1] - a[1])[0];
      const tam = M.modo === 'locais' ? Math.round(26 + 22 * Math.sqrt(p.total / max)) : 18;
      const html = M.modo === 'locais'
        ? `<span style="--cor:${COR_TIPO[dom ? dom[0] : 'G6']};width:${tam}px;height:${tam}px">${p.total}</span>`
        : '<span></span>';
      const icone = L.divIcon({ className: 'mapa-bolha' + (M.modo === 'calor' ? ' discreta' : '') + (M.sel === p.nome ? ' sel' : ''), html, iconSize: [tam, tam] });
      L.marker([p.lat, p.lng], { icon: icone, title: `${p.nome} · ${p.total} ROI${p.total === 1 ? '' : 's'}`, keyboard: true })
        .on('click', () => selecionar(p.nome, true)).addTo(M.marcas);
    }
    if (M.temp) M.temp.addTo(M.map);
  }

  function desenharLado() {
    const d = M.d, pode = ehLider();
    if (M.sel) {
      const p = d.pontos.find(x => x.nome === M.sel) || d.semPosicao.find(x => x.nome === M.sel);
      if (p) return M.lado.replaceChildren(...detalhe(p, pode).filter(Boolean));
      M.sel = '';
    }
    const linha = (p, comPos) => el('button', { class: 'mapa-local', title: `${p.nome} · ${p.total} ROI${p.total === 1 ? '' : 's'}`, onclick: () => selecionar(p.nome, comPos) },
      el('span', { class: 'mapa-pino' + (comPos ? '' : ' sem'), text: comPos ? '●' : '○' }),
      el('span', { class: 'mapa-local-nome', text: p.nome }),
      el('strong', { text: String(p.total) }));
    M.lado.replaceChildren(...[
      fecharGaveta(),
      el('h3', { text: `Locais no mapa (${d.pontos.length})` }),
      d.pontos.length ? el('div', { class: 'mapa-lista' }, d.pontos.slice().sort((a, b) => b.total - a.total).map(p => linha(p, true)))
        : el('p', { class: 'mudo pequeno', text: 'Nenhum local deste período tem posição no mapa ainda.' }),
      d.semPosicao.length ? el('h3', { text: `Sem posição no mapa (${d.semPosicao.length})` }) : null,
      d.semPosicao.length ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: pode ? 'Toque no local e marque onde ele fica. Os ROIs dele passam a aparecer no calor.' : 'Ainda não aparecem no calor.' }) : null,
      d.semPosicao.length ? el('div', { class: 'mapa-lista' }, d.semPosicao.map(p => linha(p, false))) : null,
      ehAdmin() ? el('details', { class: 'mapa-admin' },
        el('summary', { text: 'Área do mapa (admin)' }),
        el('p', { class: 'mudo pequeno', style: 'margin:0', text: d.areaPadrao ? 'Usando a área padrão (terminal, ADM, ponte e píeres).' : 'Usando a área salva pelo administrador.' }),
        el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' },
          el('button', { class: 'btn pequeno', onclick: salvarArea }, 'Salvar esta vista como área'),
          d.areaPadrao ? null : el('button', { class: 'btn fantasma pequeno', onclick: () => salvarArea(null) }, 'Voltar à área padrão'))) : null].filter(Boolean));
  }

  function fecharGaveta(soBotao) {
    const bt = el('button', { class: 'btn-icone mapa-fechar', title: 'Fechar', 'aria-label': 'Fechar a lista', onclick: () => gaveta(false) }, '✕');
    return soBotao ? bt : el('div', { class: 'mapa-lado-topo' }, el('span'), bt);
  }

  function detalhe(p, pode) {
    const temPos = 'lat' in p;
    return [
      el('div', { class: 'mapa-lado-topo' },
        el('button', { class: 'btn fantasma pequeno', onclick: () => { M.sel = ''; desenharCamadas(); desenharLado(); } }, '‹ Todos os locais'),
        fecharGaveta(true)),
      el('h3', { text: p.nome }),
      el('div', { class: 'mapa-tipos' }, Object.entries(p.porTipo).map(([g, n]) =>
        el('span', { class: 'mapa-tipo' }, el('i', { class: 'ponto-tipo', style: `background:${COR_TIPO[g]}` }), `${g} – ${M.d.grupos[g]}: ${n}`))),
      p.simulados ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `${p.simulados} simulado${p.simulados === 1 ? '' : 's'} (contam no total).` }) : null,
      el('div', { class: 'mapa-lista' }, p.rois.map(r => el('button', { class: 'mapa-roi', onclick: () => abrirRoi(r.id) },
        el('span', { class: 'ponto-tipo', style: `background:${COR_TIPO[r.tipo] || '#888'}` }),
        el('span', { style: 'min-width:0' },
          el('div', { class: 'tit' }, `ROI ${r.numero} · ${r.tipo} · ${r.data}`, r.simulado ? el('span', { class: 'etiqueta simulado', text: 'SIMULADO' }) : null),
          r.descricao ? el('div', { class: 'sub', text: r.descricao }) : null)))),
      p.rois.length < p.total ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `Mostrando ${p.rois.length} de ${p.total}.` }) : null,
      pode ? el('div', { class: 'linha', style: 'gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn primario pequeno', onclick: () => iniciarMarcacao(p.nome) }, temPos ? '📍 Mudar posição' : '📍 Marcar no mapa'),
        temPos ? el('button', { class: 'btn fantasma pequeno', onclick: () => removerPosicao(p.nome) }, 'Tirar do mapa') : null) : null
    ];
  }

  function selecionar(nome, voar) {
    M.sel = nome;
    const p = M.d.pontos.find(x => x.nome === nome);
    if (voar && p) M.map.flyTo([p.lat, p.lng], Math.max(M.map.getZoom(), 17), { duration: 0.6 });
    desenharCamadas(); desenharLado();
    gaveta(true); rotuloGaveta();
  }

  // ------------------- georreferenciar (líder e admin) -------------------
  function iniciarMarcacao(nome) {
    M.marcando = nome;
    M.tela.classList.add('marcando');
    M.faixa.hidden = false;
    M.faixa.replaceChildren(el('span', {}, 'Toque no mapa onde fica ', el('strong', { text: nome })),
      el('button', { class: 'btn fantasma pequeno', onclick: pararMarcacao }, 'Cancelar'));
  }
  function pararMarcacao() {
    M.marcando = ''; M.tela.classList.remove('marcando'); M.faixa.hidden = true;
    if (M.temp) { M.temp.remove(); M.temp = null; }
  }
  function aoClicarMapa(ev) {
    if (!M.marcando) { if (gavetaAberta()) { gaveta(false); rotuloGaveta(); } return; }
    const nome = M.marcando, { lat, lng } = ev.latlng;
    if (M.temp) M.temp.remove();
    M.temp = L.marker([lat, lng], { icon: L.divIcon({ className: 'mapa-bolha nova', html: '<span></span>', iconSize: [22, 22] }) }).addTo(M.map);
    M.faixa.replaceChildren(el('span', {}, 'Salvar aqui a posição de ', el('strong', { text: nome }), '?'),
      el('div', { class: 'linha', style: 'gap:6px' },
        el('button', { class: 'btn primario pequeno', onclick: async () => {
          try {
            await api('PUT', '/api/indicadores/mapa/ponto', { nome, lat, lng });
            pararMarcacao(); aviso('Posição salva ✓'); M.sel = nome; await carregar();
          } catch (e) { aviso(e.message, true); }
        } }, 'Salvar'),
        el('button', { class: 'btn fantasma pequeno', onclick: pararMarcacao }, 'Cancelar')));
  }
  async function removerPosicao(nome) {
    try { await api('PUT', '/api/indicadores/mapa/ponto', { nome, lat: null }); aviso('Local tirado do mapa'); await carregar(); }
    catch (e) { aviso(e.message, true); }
  }
  async function salvarArea(restaurar) {
    const b = M.map.getBounds();
    const area = restaurar === null ? null : { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
    try {
      const r = await api('PUT', '/api/indicadores/mapa/area', { area });
      M.d.area = r.area; M.d.areaPadrao = area === null;
      M.map.setMaxBounds(limites(r.area).pad(0.6));
      if (area === null) centralizar();
      aviso(area === null ? 'Área padrão restaurada' : 'Área do mapa salva ✓');
      desenharLado();
    } catch (e) { aviso(e.message, true); }
  }

  return { abrir, fechar };
})();

'use strict';
// =====================================================================
// CAVEIRA BOT · Painel do CCOS (v4)
// Plantão (Turno · Relatório · E-mails) · Pendências (Pendências · Mensagens) · Histórico · Painel
// Tudo vem do servidor; o texto publicado é exatamente o da Prévia.
// =====================================================================

// ---------------------------- Utilidades ----------------------------
const $ = (s, r = document) => r.querySelector(s);

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    e.append(f instanceof Node ? f : String(f));
  }
  return e;
}

const uid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const clone = o => JSON.parse(JSON.stringify(o));
const FUSO = 'America/Sao_Paulo';

function agoraBR() {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { data: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

function quando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const f = o => new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, ...o }).format(d);
  const hora = f({ hour: '2-digit', minute: '2-digit', hour12: false });
  return f({ day: '2-digit', month: '2-digit', year: 'numeric' }) === agoraBR().data ? `hoje às ${hora}` : `${f({ day: '2-digit', month: '2-digit' })} às ${hora}`;
}

function autoAltura(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px'; }

function aviso(texto, falha = false) {
  const a = $('#aviso');
  a.textContent = texto;
  a.className = 'aviso' + (falha ? ' falha' : '');
  a.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { a.hidden = true; }, falha ? 5000 : 2600);
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); }
  catch (_) {
    const t = el('textarea', { value: texto, style: 'position:fixed;opacity:0' });
    document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  aviso('Copiado ✓');
}

function baixar(nome, texto) {
  const a = el('a', { href: URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' })), download: nome });
  document.body.append(a); a.click(); a.remove();
}

function textoWhats(texto) {
  const frag = document.createDocumentFragment();
  String(texto).split('\n').forEach((linha, i) => {
    if (i) frag.append('\n');
    linha.split(/(\*[^*\n]+\*)/g).forEach(p => {
      if (/^\*[^*\n]+\*$/.test(p)) frag.append(el('strong', { text: p.slice(1, -1) }));
      else if (p) frag.append(p);
    });
  });
  return frag;
}

// ------------------------------- API --------------------------------
async function api(metodo, url, corpo) {
  const r = await fetch(url, {
    method: metodo, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Caveira': '1' },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  if (r.status === 401 && !url.endsWith('/login')) { mostrarLogin(); throw new Error(d.erro || 'Sessão expirada.'); }
  if (r.status === 403 && d.trocarSenha) { pedirTrocaSenha(true); throw new Error(d.erro); }
  if (!r.ok) { const e = new Error(d.erro || `Erro ${r.status}`); e.status = r.status; e.dados = d; throw e; }
  return d;
}

async function baixarArquivo(url, nomePadrao) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) { let d = {}; try { d = await r.json(); } catch (_) {} throw new Error(d.erro || `Erro ${r.status}`); }
    const nome = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || nomePadrao;
    const blob = await r.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: nome });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    aviso('Planilha baixada ✓');
  } catch (e) { aviso(e.message, true); }
}

// ------------------------------ Estado ------------------------------
const S = {
  usuario: null, meta: null, estado: null, aba: 'central', ultimaAba: {}, historico: null, filtroEmails: 'todos', buscaHist: '',
  central: null, ficha: null, fichaBase: null, versao: 0, conferencia: [], avisos: [], operacoes: [],
  entrada: [], config: null, filtroEntrada: 'pendente', busca: '', filtroPend: 'todas',
  sujo: false, salvando: false, timerSalvar: null, timerEstado: null, painelTimer: null
};
const ehLider = () => ['ADMIN', 'LIDER'].includes(S.usuario?.perfil);
const ehAdmin = () => S.usuario?.perfil === 'ADMIN';
const deplantao = () => S.estado?.plantao?.liderId === S.usuario?.id;

const DESTINOS = {
  ATIVIDADE: { rotulo: 'Atividade', ic: '📝', desc: 'Seção 4 · Atividades realizadas' },
  OCORRENCIA: { rotulo: 'Ocorrência', ic: '🚨', desc: 'Seção 7 · Ocorrências' },
  AVISO: { rotulo: 'Aviso', ic: '📌', desc: 'Pendência · aparece na seção 5 até ser concluído' },
  DIGITAL: { rotulo: 'Pendência da Digital', ic: '🛠️', desc: 'CFTV, câmeras, SPDA, fibra… · vai para a passagem da escala' },
  NAVIO: { rotulo: 'Navios', ic: '🚢', desc: 'Seção 6 · Movimentação de navios' },
  OPERACAO: { rotulo: 'Operação de bordo', ic: '✉️', desc: 'Rancho, tripulantes, resíduos… · gera e-mail (um por navio)' },
  SAIDA: { rotulo: 'Saída de veículo', ic: '🏁', desc: 'Fecha uma operação em andamento e libera o e-mail' }
};

// ------------------------------ Janela ------------------------------
function abrirModal(titulo, corpo, rodape = [], { travado = false } = {}) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').replaceChildren(...[].concat(corpo).filter(Boolean));
  $('#modal-rodape').replaceChildren(...[].concat(rodape).filter(Boolean));
  $('#modal').dataset.travado = travado ? '1' : '';
  $('#modal [data-fechar]').hidden = travado;
  $('#modal').hidden = false;
  requestAnimationFrame(() => {
    $('#modal-corpo').querySelectorAll('textarea').forEach(autoAltura);
    const foco = $('#modal-corpo [autofocus]'); if (foco) foco.focus();
  });
}
function fecharModal() { $('#modal').hidden = true; $('#modal').dataset.travado = ''; }
const modalAberto = () => !$('#modal').hidden;

function confirmar(titulo, conteudo, rotuloOk = 'Confirmar', perigo = false) {
  return new Promise(ok => {
    const fim = v => { fecharModal(); ok(v); };
    abrirModal(titulo, [].concat(conteudo).map(c => typeof c === 'string' ? el('p', { text: c }) : c), [
      el('button', { class: 'btn fantasma', onclick: () => fim(false) }, 'Cancelar'),
      el('button', { class: `btn ${perigo ? 'perigo' : 'primario'}`, onclick: () => fim(true) }, rotuloOk)
    ]);
  });
}

function campoTexto(rotulo, valor, opts = {}) {
  const t = el('textarea', { rows: opts.linhas || 3, value: valor || '', placeholder: opts.placeholder, autofocus: opts.autofocus, oninput: e => autoAltura(e.target) });
  return [rotulo ? el('label', { class: 'campo' }, rotulo, t) : t, t];
}
function campoLinha(rotulo, valor, opts = {}) {
  const i = el('input', { type: opts.tipo || 'text', value: valor ?? '', placeholder: opts.placeholder, autofocus: opts.autofocus, inputmode: opts.inputmode });
  return [el('label', { class: 'campo' }, rotulo, i), i];
}
function botoesSalvar(onSalvar, rotulo = 'Salvar', classe = 'primario') {
  return [
    el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'),
    el('button', {
      class: `btn ${classe}`, onclick: async ev => {
        ev.target.disabled = true;
        try { await onSalvar(); } catch (e) { aviso(e.message, true); ev.target.disabled = false; }
      }
    }, rotulo)
  ];
}

// ------------------------------ Login -------------------------------
// Capa de abertura: fica no mínimo 0,9 s e some quando a primeira tela estiver pronta
const INICIO_CAPA = performance.now();
function esconderCapa() {
  const c = document.getElementById('capa');
  if (!c || c.classList.contains('saindo')) return;
  setTimeout(() => { c.classList.add('saindo'); setTimeout(() => c.remove(), 500); }, Math.max(0, 900 - (performance.now() - INICIO_CAPA)));
}

function mostrarLogin() {
  esconderCapa();
  clearInterval(S.timerEstado);
  $('#app').hidden = true; $('#painel').hidden = true; fecharModal();
  $('#tela-login').hidden = false;
  setTimeout(() => ($('#login-email').value ? $('#login-senha') : $('#login-email')).focus(), 50);
}

$('#form-login').addEventListener('submit', async ev => {
  ev.preventDefault();
  const erro = $('#login-erro'); erro.hidden = true;
  try {
    const r = await api('POST', '/api/login', { email: $('#login-email').value, senha: $('#login-senha').value });
    $('#login-senha').value = '';
    S.usuario = r.usuario;
    if (r.usuario.trocarSenha) return pedirTrocaSenha(true);
    entrar();
  } catch (e) { erro.textContent = e.message; erro.hidden = false; }
});

function pedirTrocaSenha(obrigatoria = false) {
  $('#tela-login').hidden = true;
  const [c1, atual] = campoLinha(obrigatoria ? 'Senha provisória (a que você recebeu)' : 'Senha atual', '', { tipo: 'password', autofocus: true });
  const [c2, nova] = campoLinha('Nova senha (mínimo 8 caracteres)', '', { tipo: 'password' });
  const [c3, conf] = campoLinha('Repita a nova senha', '', { tipo: 'password' });
  abrirModal(obrigatoria ? '🔐 Crie sua senha' : 'Trocar senha', [
    obrigatoria ? el('p', { class: 'mudo', text: 'É o seu primeiro acesso (ou sua senha foi redefinida). Crie uma senha pessoal para continuar.' }) : null,
    c1, c2, c3
  ], [
    obrigatoria ? null : el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'),
    el('button', {
      class: 'btn primario', onclick: async () => {
        if (nova.value !== conf.value) return aviso('As senhas não conferem.', true);
        try {
          const r = await api('POST', '/api/eu/senha', { atual: atual.value, nova: nova.value });
          S.usuario = r.usuario; fecharModal(); aviso('Senha alterada ✓');
          if (obrigatoria) entrar();
        } catch (e) { aviso(e.message, true); }
      }
    }, 'Salvar senha')
  ], { travado: obrigatoria });
}

async function entrar() {
  $('#tela-login').hidden = true;
  $('#app').hidden = false;
  try {
    [S.meta, S.estado] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/estado')]);
    S.usuario = S.estado.usuario;
    await Promise.all([carregarCentral(), carregarFicha(), carregarEntrada(), carregarConfig()]);
  } catch (e) { esconderCapa(); if (e.status !== 403 && e.status !== 401) aviso(e.message, true); return; }
  desenharTopo();
  trocarAba(S.aba);
  esconderCapa();
  clearInterval(S.timerEstado);
  S.timerEstado = setInterval(atualizarEstado, 6000);
}

async function carregarCentral() { S.central = await api('GET', '/api/central'); }
async function carregarEntrada() { S.entrada = (await api('GET', '/api/entrada')).itens; }
async function carregarConfig() { S.config = (await api('GET', '/api/config')).config; }
async function carregarFicha() {
  const f = await api('GET', '/api/ficha');
  S.ficha = f.ficha; S.fichaBase = clone(f.ficha); S.versao = f.ficha.versao || 0;
  S.conferencia = f.conferencia; S.avisos = f.avisos; S.operacoes = f.operacoes;
}


// ------------------------- Fundo animado (rede) ---------------------
// Pontos que se movem sozinhos; ao tocar/passar o mouse, os pontos próximos
// são atraídos e ligados ao dedo; um toque solta uma "onda" que os empurra.
const Fundo = (() => {
  const cv = document.getElementById('fundo-animado');
  if (!cv || !cv.getContext) return { ligar() {}, ativo: () => false };
  const ctx = cv.getContext('2d');
  const calmo = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let L = 0, A = 0, dpr = 1, pontos = [], ativo = true, rodando = false, ultimo = 0;
  const dedo = { x: 0, y: 0, ativo: false, ate: 0 };
  const ondas = [];
  let DIST = 130, RAIO = 170;

  function criar() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    L = window.innerWidth; A = window.innerHeight;
    cv.width = Math.round(L * dpr); cv.height = Math.round(A * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    DIST = L < 600 ? 120 : 150; RAIO = L < 600 ? 140 : 180;
    const n = Math.max(40, Math.min(130, Math.round((L * A) / 10000)));
    pontos = Array.from({ length: n }, () => {
      const ang = Math.random() * Math.PI * 2, v = 0.15 + Math.random() * 0.35;
      return { x: Math.random() * L, y: Math.random() * A, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, r: 1.2 + Math.random() * 2.4, fase: Math.random() * 6.28 };
    });
  }

  function passo(dt) {
    const agora = performance.now();
    const tocando = dedo.ativo || agora < dedo.ate;
    for (const p of pontos) {
      // passeio aleatório suave
      p.vx += (Math.random() - 0.5) * 0.02 * dt; p.vy += (Math.random() - 0.5) * 0.02 * dt;
      if (tocando) {
        const dx = dedo.x - p.x, dy = dedo.y - p.y, d = Math.hypot(dx, dy);
        if (d < RAIO && d > 1) { const f = (1 - d / RAIO) * 0.045 * dt; p.vx += (dx / d) * f; p.vy += (dy / d) * f; if (d < 26) { p.vx -= (dx / d) * 0.12 * dt; p.vy -= (dy / d) * 0.12 * dt; } }
      }
      for (const o of ondas) {
        const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy);
        if (d > 1 && Math.abs(d - o.r) < 40) { const f = 0.5 * o.forca * dt; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
      }
      const vel = Math.hypot(p.vx, p.vy), max = tocando ? 2.6 : 1.4;
      if (vel > max) { p.vx *= max / vel; p.vy *= max / vel; }
      if (vel < 0.12) { p.vx *= 1.05; p.vy *= 1.05; }
      p.vx *= 0.995; p.vy *= 0.995;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < -20) p.x = L + 20; else if (p.x > L + 20) p.x = -20;
      if (p.y < -20) p.y = A + 20; else if (p.y > A + 20) p.y = -20;
    }
    for (let i = ondas.length - 1; i >= 0; i--) { ondas[i].r += 6 * dt; ondas[i].forca *= 0.94; if (ondas[i].r > 320) ondas.splice(i, 1); }
  }

  function desenhar() {
    ctx.clearRect(0, 0, L, A);
    const t = performance.now() / 1000;
    const tocando = dedo.ativo || performance.now() < dedo.ate;
    ctx.lineWidth = 1;
    for (let i = 0; i < pontos.length; i++) {
      const a = pontos[i];
      for (let j = i + 1; j < pontos.length; j++) {
        const b = pontos[j], dx = a.x - b.x, dy = a.y - b.y;
        if (Math.abs(dx) > DIST || Math.abs(dy) > DIST) continue;
        const d = Math.hypot(dx, dy);
        if (d < DIST) { ctx.strokeStyle = `rgba(56,189,248,${(1 - d / DIST) * 0.45})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      if (tocando) {
        const d = Math.hypot(a.x - dedo.x, a.y - dedo.y);
        if (d < RAIO) { ctx.strokeStyle = `rgba(125,211,252,${(1 - d / RAIO) * 0.6})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(dedo.x, dedo.y); ctx.stroke(); }
      }
    }
    for (const p of pontos) {
      const brilho = 0.55 + 0.45 * Math.sin(t * 1.6 + p.fase);
      ctx.fillStyle = `rgba(103,232,249,${0.35 + 0.5 * brilho})`;
      ctx.shadowColor = 'rgba(56,189,248,.9)'; ctx.shadowBlur = 6 + 6 * brilho;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    for (const o of ondas) { ctx.strokeStyle = `rgba(125,211,252,${Math.max(0, 0.35 * (1 - o.r / 320))})`; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.stroke(); }
  }

  function quadro(ts) {
    if (!ativo || document.hidden) { rodando = false; return; }
    const dt = Math.min(3, ultimo ? (ts - ultimo) / 16.67 : 1);
    ultimo = ts;
    passo(dt); desenhar();
    requestAnimationFrame(quadro);
  }
  function iniciar() {
    if (rodando || !ativo) return;
    if (calmo) { desenhar(); return; }
    rodando = true; ultimo = 0; requestAnimationFrame(quadro);
  }

  const mover = (x, y) => { dedo.x = x; dedo.y = y; dedo.ativo = true; };
  window.addEventListener('pointermove', e => mover(e.clientX, e.clientY), { passive: true });
  window.addEventListener('pointerdown', e => { mover(e.clientX, e.clientY); if (ativo && !calmo) ondas.push({ x: e.clientX, y: e.clientY, r: 4, forca: 1 }); }, { passive: true });
  window.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { dedo.ativo = false; dedo.ate = performance.now() + 900; } }, { passive: true });
  window.addEventListener('pointercancel', () => { dedo.ativo = false; dedo.ate = performance.now() + 900; }, { passive: true });
  document.addEventListener('pointerleave', () => { dedo.ativo = false; }, { passive: true });
  window.addEventListener('blur', () => { dedo.ativo = false; });
  let tr; window.addEventListener('resize', () => { clearTimeout(tr); tr = setTimeout(() => { criar(); if (calmo) desenhar(); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) iniciar(); });

  function ligar(sim) {
    ativo = !!sim;
    document.documentElement.classList.toggle('sem-fundo', !ativo);
    try { localStorage.setItem('caveira_fundo', ativo ? '1' : '0'); } catch (_) { }
    if (ativo) iniciar(); else ctx.clearRect(0, 0, L, A);
  }
  let salvo = '1';
  try { salvo = localStorage.getItem('caveira_fundo') ?? '1'; } catch (_) { }
  criar();
  ligar(salvo !== '0');
  return { ligar, ativo: () => ativo };
})();

// --------------------------- Topo e abas ----------------------------
function desenharTopo() {
  const e = S.estado;
  const lider = e?.plantao?.liderNome ? ` · Líder: ${e.plantao.liderNome.split(' ')[0]}` : ' · sem líder de plantão';
  $('#topo-sub').textContent = e ? `${e.turno.turno} ${e.turno.data.slice(0, 5)}${lider}` : '';
  const w = e?.whatsapp?.plantao?.estado || (e?.plantao?.liderId ? 'PAUSADO' : 'SEM_LIDER');
  const mapa = {
    CONECTADO: ['ok', 'Conectado'], AGUARDANDO_PAREAMENTO: ['atencao', 'Conectar'], CONECTANDO: ['atencao', 'Conectando'],
    RECONECTANDO: ['atencao', 'Reconectando'], SEM_LIDER: ['atencao', 'Sem líder']
  };
  const [classe, txt] = mapa[w] || ['falha', 'Offline'];
  const p = $('#pilula-whats');
  p.className = 'pilula ' + classe;
  p.querySelector('.txt').textContent = txt;
  const bp = $('#badge-pendencias');
  const np = (S.central ? itensPendentes().length : (e?.pendenciasAbertas || 0)) + (e?.pendentesEntrada || 0);
  bp.hidden = !np; bp.textContent = np > 99 ? '99+' : np;
  bp.style.background = e?.urgentes || (S.central && emailsPendentes().some(o => o.email?.status === 'ERRO')) ? 'var(--vermelho)' : 'var(--ambar)';
  if (!$('#subabas').hidden) desenharSubabas();
  const bc = $('#badge-central');
  const alerta = (e?.plantao?.relatorioPendenteId ? 1 : 0) + (e?.plantao?.sugerirNovaEscala && deplantao() ? 1 : 0) + (!e?.plantao?.liderId ? 1 : 0);
  bc.hidden = !alerta; bc.textContent = '!'; bc.style.background = 'var(--ambar)';
}

// Computador (tela larga): menu lateral, prévia ao vivo do relatório e histórico lado a lado
const MQ_DESKTOP = window.matchMedia('(min-width: 1024px)');
const ehDesktop = () => MQ_DESKTOP.matches;
MQ_DESKTOP.addEventListener?.('change', () => { if (S.ficha) redesenharAba(); });

// Navegação: 4 abas principais; Plantão e Pendências têm subabas
const GRUPOS = { plantao: ['central', 'relatorio', 'emails'], pendencias: ['pendencias', 'entrada'], historico: ['historico'], painel: ['painel'] };
const ROTULOS_SUB = { central: 'Turno', relatorio: 'Relatório', emails: 'E-mails', pendencias: 'Pendências', entrada: 'Mensagens do grupo' };
const grupoDa = aba => Object.keys(GRUPOS).find(g => GRUPOS[g].includes(aba)) || 'plantao';
const DESENHAR = {
  central: () => desenharCentral(), relatorio: () => desenharRelatorio(), emails: () => desenharEmails(),
  pendencias: () => desenharPendencias(), entrada: () => desenharEntrada(), historico: () => desenharHistorico(), painel: () => desenharPainelGerencial()
};
function redesenharAba() { (DESENHAR[S.aba] || (() => {}))(); }

function desenharSubabas() {
  const box = $('#subabas');
  const vistas = GRUPOS[grupoDa(S.aba)];
  box.hidden = vistas.length < 2;
  if (box.hidden) return;
  const contagem = {
    emails: S.central ? emailsPendentes().length : 0,
    pendencias: S.central ? itensPendentes().length : 0,
    entrada: S.estado?.pendentesEntrada || 0
  };
  box.replaceChildren(...vistas.map(v => el('button', { class: v === S.aba ? 'ativa' : '', onclick: () => trocarAba(v) },
    ROTULOS_SUB[v], contagem[v] ? el('span', { class: 'n', text: contagem[v] > 99 ? '99+' : String(contagem[v]) }) : null)));
}

function trocarAba(nome) {
  if (nome === 'plantao' || nome === 'pendencias-grupo') nome = S.ultimaAba[nome === 'plantao' ? 'plantao' : 'pendencias'] || (nome === 'plantao' ? 'central' : 'pendencias');
  S.aba = DESENHAR[nome] ? nome : 'central';
  const g = grupoDa(S.aba);
  S.ultimaAba[g] = S.aba;
  document.querySelectorAll('.abas button').forEach(b => b.classList.toggle('ativa', b.dataset.grupo === g));
  document.querySelectorAll('.aba').forEach(x => { x.hidden = x.id !== `aba-${S.aba}`; });
  $('#conteudo').classList.toggle('largo', S.aba === 'central' || S.aba === 'historico' || S.aba === 'painel');
  desenharSubabas();
  redesenharAba();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.abas button').forEach(b => b.addEventListener('click', () => {
  const g = b.dataset.grupo;
  trocarAba(S.ultimaAba[g] || GRUPOS[g][0]);
}));
$('#btn-menu').addEventListener('click', abrirMenu);
$('#pilula-whats').addEventListener('click', () => (ehLider() ? abrirPerfil() : aviso('O WhatsApp é do líder de plantão.')));
$('#modal').addEventListener('click', e => {
  if ($('#modal').dataset.travado) return;
  if (e.target.id === 'modal' || e.target.closest('[data-fechar]')) fecharModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalAberto() && !$('#modal').dataset.travado) fecharModal(); });

// ------------------------ Atualização periódica ---------------------
async function atualizarEstado() {
  try {
    const ant = S.estado;
    S.estado = await api('GET', '/api/estado');
    S.usuario = S.estado.usuario;
    desenharTopo();
    const m = S.estado.marcas, a = ant?.marcas || {};
    const livre = !modalAberto() && $('#painel').hidden;

    if (m.relatorios !== a.relatorios && ant) aviso('📑 Relatório da equipe anterior atualizado');
    if (m.historico !== a.historico && ant) { S.historico = null; if (S.aba === 'historico' && livre) desenharHistorico(); }
    if (m.pendencias !== a.pendencias || m.operacoes !== a.operacoes || m.relatorios !== a.relatorios || m.plantao !== a.plantao || m.ficha !== a.ficha) {
      await carregarCentral();
      if (['central', 'pendencias', 'emails'].includes(S.aba) && livre) redesenharAba();
      desenharSubabas();
    }
    if (S.estado.pendentesEntrada !== ant?.pendentesEntrada || S.estado.urgentes !== ant?.urgentes || m.operacoes !== a.operacoes) {
      await carregarEntrada();
      if (S.aba === 'entrada' && livre) desenharListaEntrada();
      desenharSubabas();
      if (S.estado.urgentes > (ant?.urgentes || 0)) aviso('🚨 Mensagem urgente no grupo (Pendências › Mensagens)', true);
    }
    const editando = document.activeElement && $('#aba-relatorio').contains(document.activeElement);
    if ((m.ficha !== S.versao || m.pendencias !== a.pendencias || m.operacoes !== a.operacoes) && !S.sujo && !S.salvando && !editando && livre) {
      await carregarFicha();
      if (S.aba === 'relatorio') desenharRelatorio();
    }
  } catch (_) { /* sem conexão: tenta no próximo ciclo */ }
}

// ------------------------ Salvar a ficha (com mesclagem) ------------
function mesclarLista(base = [], local = [], servidor = []) {
  const idsBase = new Set(base.map(i => i.id));
  const idsLocal = new Set(local.map(i => i.id));
  return [...local, ...servidor.filter(i => !idsLocal.has(i.id) && !idsBase.has(i.id))];
}

function mesclarFicha(base, local, servidor) {
  const r = clone(servidor);
  for (const k of ['turno', 'data', 'efetivo', 'vtr', 'sistemas', 'equipes']) {
    if (JSON.stringify(local[k]) !== JSON.stringify(base[k])) r[k] = local[k];
  }
  r.atividades = mesclarLista(base.atividades, local.atividades, servidor.atividades);
  r.ocorrencias = mesclarLista(base.ocorrencias, local.ocorrencias, servidor.ocorrencias);
  r.navios = {
    tore: mesclarLista(base.navios?.tore, local.navios?.tore, servidor.navios?.tore),
    toil: mesclarLista(base.navios?.toil, local.navios?.toil, servidor.navios?.toil)
  };
  return r;
}

function agendarSalvar() {
  requestAnimationFrame(atualizarProgresso);
  S.sujo = true;
  marcarEstadoSalvo('Salvando…');
  clearTimeout(S.timerSalvar);
  S.timerSalvar = setTimeout(salvarFicha, 700);
}

async function salvarFicha(tentativa = 0) {
  clearTimeout(S.timerSalvar);
  if (S.salvando) { S.timerSalvar = setTimeout(salvarFicha, 300); return; }
  if (!S.sujo) return;
  S.salvando = true; S.sujo = false;
  try {
    const r = await api('PUT', '/api/ficha', { ficha: S.ficha, versao: S.versao });
    S.versao = r.ficha.versao; S.ficha.versao = r.ficha.versao; S.ficha.atualizadoEm = r.ficha.atualizadoEm;
    S.fichaBase = clone(r.ficha); S.conferencia = r.conferencia;
    marcarEstadoSalvo('Salvo ✓');
    desenharConferencia();
    atualizarPreviaViva();
  } catch (e) {
    if (e.status === 409 && e.dados?.ficha && tentativa < 2) {
      // outra pessoa (ou o robô) mexeu ao mesmo tempo: junta as duas versões
      const servidor = e.dados.ficha;
      S.ficha = mesclarFicha(S.fichaBase, S.ficha, servidor);
      S.versao = servidor.versao; S.fichaBase = clone(servidor);
      S.salvando = false; S.sujo = true;
      await salvarFicha(tentativa + 1);
      if (S.aba === 'relatorio' && !(document.activeElement && $('#aba-relatorio').contains(document.activeElement))) desenharRelatorio();
      return;
    }
    S.sujo = true; marcarEstadoSalvo('Não salvo — tentando de novo');
    S.timerSalvar = setTimeout(salvarFicha, 4000);
  } finally { S.salvando = false; }
}

async function salvarAgora() {
  if (S.sujo) await salvarFicha();
  while (S.salvando) await new Promise(r => setTimeout(r, 100));
}
function marcarEstadoSalvo(txt) { const e = $('#estado-salvo'); if (e) e.textContent = txt; }

async function alterarFicha(fn) {
  await salvarAgora();
  fn(S.ficha);
  S.sujo = true;
  await salvarFicha();
  if (S.aba === 'relatorio') desenharRelatorio();
}

async function recarregarTudo() {
  await Promise.all([carregarCentral(), carregarFicha(), carregarEntrada()]);
  try { S.estado = await api('GET', '/api/estado'); } catch (_) {}
  desenharTopo();
  desenharSubabas();
  redesenharAba();
}

// =====================================================================
// ABA 1 · CENTRAL DO PLANTÃO
// =====================================================================
function desenharCentral() {
  const c = $('#aba-central');
  const C = S.central, E = S.estado;
  if (!C || !E) return;
  const esq = el('div'), dir = el('div');

  // --- Plantão
  const p = E.plantao;
  const semSaida = C.operacoes.filter(o => !o.horaFinal).length;
  if (!p.liderId) {
    esq.append(el('div', { class: 'faixa atencao' },
      el('strong', { text: 'Ninguém assumiu o plantão' }),
      el('p', { class: 'pequeno', text: 'Ao assumir, o relatório é publicado pelo seu WhatsApp e os e-mails de bordo chegam no seu e-mail.' }),
      ehLider() ? el('div', {}, el('button', { class: 'btn primario', onclick: assumir }, '🙋 Assumir plantão')) : null));
  } else {
    const eq = C.ficha.equipes || {};
    esq.append(el('div', { class: 'faixa' },
      el('div', { class: 'cartao-topo' },
        el('div', {},
          el('h3', { class: 'mudo pequeno', text: 'PLANTÃO' }),
          el('h2', { text: `${E.turno.turno} · ${E.turno.data}` }),
          el('span', { class: 'mudo pequeno', text: `Líder: ${p.liderNome} · desde ${quando(p.assumidoEm)}` }),
          eq.saindo && !/conforme/i.test(eq.saindo) ? el('div', { class: 'mudo pequeno', text: `Equipe de serviço: ${eq.saindo}` }) : null),
        ehLider() && !deplantao() ? el('button', { class: 'btn pequeno', onclick: assumir }, 'Assumir') : el('span', { class: 'etiqueta ok', text: deplantao() ? 'Você' : 'Ativo' })),
      el('div', { class: 'contadores' },
        contador(E.urgentes, 'Urgentes', () => { S.filtroEntrada = 'pendente'; trocarAba('entrada'); }, E.urgentes > 0),
        contador(emailsPendentes().length, 'E-mails', () => { S.filtroEmails = 'encaminhar'; trocarAba('emails'); }, emailsPendentes().some(o => o.email?.status === 'ERRO')),
        contador(semSaida, 'Sem saída', () => { S.filtroEmails = 'semsaida'; trocarAba('emails'); }, false)),
      deplantao() ? el('button', { class: 'btn primario largo', style: 'padding:13px;font-size:15px', onclick: () => trocarAba('relatorio') }, '📑 Fechar turno') : null));
  }

  // --- Sugestão de nova escala (só para o líder de plantão)
  if (p.sugerirNovaEscala && deplantao()) {
    esq.append(el('div', { class: 'faixa info' },
      el('strong', { text: '📦 Parece o primeiro turno da escala' }),
      el('p', { class: 'pequeno', text: C.escala ? `A escala atual começou em ${C.escala.dataInicio}. Iniciar uma nova para coletar as informações desde hoje?` : 'Inicie a escala para o robô coletar as informações de todos os turnos até a passagem.' }),
      el('div', { class: 'linha' },
        el('button', { class: 'btn primario', onclick: async () => { await api('POST', '/api/escala/iniciar'); aviso('Nova escala iniciada ✓'); recarregarTudo(); } }, 'Iniciar nova escala'),
        C.escala ? el('button', { class: 'btn fantasma', onclick: async () => { await api('POST', '/api/escala/continuar'); recarregarTudo(); } }, 'Continuar a atual') : null)));
  }

  // --- Relatório novo aguardando decisão
  if (C.relatorioPendente) {
    const r = C.relatorioPendente;
    esq.append(el('div', { class: 'faixa atencao' },
      el('strong', { text: `📑 Chegou um relatório novo: ${r.dados.turno || ''} ${r.dados.data || ''} (${r.autor || ''})` }),
      el('p', { class: 'pequeno', text: 'Seu turno atual ainda não foi publicado, por isso o robô não trocou sozinho.' }),
      ehLider() ? el('div', { class: 'linha' },
        el('button', { class: 'btn primario', onclick: () => herdar(r) }, 'Herdar agora'),
        el('button', { class: 'btn fantasma', onclick: async () => { await api('POST', '/api/plantao/manter-turno'); recarregarTudo(); } }, 'Manter meu turno')) : null));
  }

  esq.append(cartaoPassagemTurno());
  esq.append(el('div', { class: 'rodape-discreto' }, el('button', { onclick: abrirEscala }, '📦 Passagem da escala')));

  // --- Pendências ao lado (no celular, logo abaixo)
  dir.append(cartaoPendencias());
  c.replaceChildren(el('div', { class: 'duas-colunas' }, esq, dir));
}

function contador(n, rotulo, onclick, alerta = false) {
  return el('button', { class: `contador${alerta ? ' alerta' : ''}`, onclick }, el('strong', { text: String(n || 0) }), el('span', { text: rotulo }));
}

async function assumir() {
  try {
    await api('POST', '/api/plantao/assumir');
    aviso('Plantão assumido ✓');
    await recarregarTudo();
  } catch (e) { aviso(e.message, true); }
}

function cartaoPassagemTurno() {
  const f = S.central.ficha;
  const h = f.herdadoDe;
  const detalhes = el('div', { hidden: true, style: 'display:grid;gap:8px' });
  if (h) {
    detalhes.append(el('div', { class: 'linha' },
      (h.encontrados || []).map(x => el('span', { class: 'etiqueta ok', text: '✓ ' + x })),
      (h.faltando || []).map(x => el('span', { class: 'etiqueta atencao', text: '? ' + x }))));
    const rel = S.central.relatorios.find(r => r.id === h.relatorioId);
    if (rel) detalhes.append(el('div', { class: 'texto-bruto', text: rel.texto }));
  }
  const total = h ? (h.encontrados || []).length + (h.faltando || []).length : 0;
  return el('section', { class: 'cartao' },
    el('div', { class: 'cartao-topo' },
      el('div', {},
        el('h3', { text: 'Passagem de turno' }),
        el('h2', { text: h ? (h.publicado ? `Preparado após a publicação de ${h.autor || 'líder'}` : `Herdado de ${h.autor || 'equipe anterior'}`) : 'Turno sem herança' }),
        el('p', { class: 'mudo pequeno', style: 'margin:4px 0 0', text: h ? `Relatório ${h.turno || ''} ${h.data || ''} · ${quando(h.capturadoEm)}` : 'Quando o relatório for postado no grupo, o robô prepara seu turno sozinho.' })),
      h && !h.publicado ? el('button', { class: `etiqueta ${(h.faltando || []).length ? 'atencao' : 'ok'}`, style: 'cursor:pointer', onclick: () => { detalhes.hidden = !detalhes.hidden; } },
        (h.faltando || []).length ? `⚠ ${(h.faltando || []).length} faltando ▾` : `✓ ${total} de ${total} campos ▾`) : null),
    detalhes,
    el('div', { class: 'linha' },
      el('button', { class: 'btn pequeno', onclick: () => trocarAba('historico') }, '🗂️ Escolher no histórico'),
      el('button', { class: 'btn fantasma pequeno', onclick: abrirColarRelatorio }, '📋 Colar relatório'),
      ehLider() ? el('button', { class: 'btn fantasma pequeno', onclick: novaEmBranco }, 'Turno em branco') : null)
  );
}

function escolherRelatorio() {
  const lista = S.central.relatorios.map(r => el('div', { class: 'usuario-card' },
    el('div', { class: 'cartao-topo' },
      el('div', {}, el('strong', { text: `${r.dados.turno || '?'} · ${r.dados.data || 'sem data'}` }),
        el('div', { class: 'mudo pequeno', text: `${r.manual ? 'Colado manualmente' : r.autor} · ${quando(r.capturadoEm)}` })),
      r.herdadoEm ? el('span', { class: 'etiqueta ok', text: 'herdado' }) : null),
    el('details', {}, el('summary', { class: 'mudo pequeno', style: 'cursor:pointer', text: 'Ver texto' }), el('div', { class: 'texto-bruto', style: 'margin-top:6px', text: r.texto })),
    ehLider() ? el('div', {}, el('button', { class: 'btn primario pequeno', onclick: () => herdar(r) }, 'Herdar este')) : null));
  abrirModal('Relatórios capturados (últimos 10)', lista);
}

async function herdar(r) {
  const d = r.dados;
  const ok = await confirmar('Herdar este relatório?', [
    el('p', { text: `Turno ${d.turno || '?'} de ${d.data || '?'} (${r.autor || 'equipe anterior'}). Vai começar o próximo turno com:` }),
    el('ul', { style: 'margin:0;padding-left:20px' },
      el('li', { text: `KM inicial da VTR: ${d.vtr.kmFinal != null ? d.vtr.kmFinal.toLocaleString('pt-BR') : 'não encontrado'}` }),
      el('li', { text: 'Sistemas e navios do relatório; avisos viram pendências' }),
      el('li', { text: `Equipe saindo: ${d.equipes.assumindo || '(preencher)'}` })),
    el('p', { class: 'mudo pequeno', text: 'O turno atual vai para o histórico e para a coleta da escala.' })
  ], 'Herdar');
  if (!ok) return;
  try {
    await api('POST', '/api/ficha/herdar', { relatorioId: r.id });
    aviso('Turno iniciado com os dados herdados ✓');
    await recarregarTudo();
  } catch (e) { aviso(e.message, true); }
}

function abrirColarRelatorio() {
  const [, txt] = campoTexto('', '', { linhas: 12, placeholder: 'Cole aqui o texto completo do "RELATÓRIO DO TURNO"…', autofocus: true });
  abrirModal('Colar relatório da equipe anterior', [el('p', { class: 'mudo pequeno', text: 'Use quando o relatório foi postado com o robô desligado ou em outro grupo.' }), txt], botoesSalvar(async () => {
    const r = await api('POST', '/api/relatorios', { texto: txt.value });
    fecharModal();
    await carregarCentral();
    if (ehLider()) herdar(r.relatorio); else { aviso('Relatório lido ✓ — um líder pode herdá-lo.'); desenharCentral(); }
  }, 'Ler relatório'));
}

async function novaEmBranco() {
  if (!await confirmar('Começar um turno em branco?', 'O turno atual vai para o histórico. O KM final vira KM inicial e os navios continuam.', 'Começar')) return;
  try { await api('POST', '/api/ficha/nova'); await recarregarTudo(); trocarAba('relatorio'); } catch (e) { aviso(e.message, true); }
}

// ------------------------------ Pendências --------------------------
function emailsPendentes() {
  return (S.central?.operacoes || []).filter(o => o.horaFinal && !o.email?.encaminhadoEm);
}

function itensPendentes() {
  const C = S.central;
  const itens = [];
  for (const p of C.pendencias.filter(x => x.status === 'ABERTA')) {
    itens.push({
      grupo: p.tipo === 'DIGITAL' ? 'digital' : 'avisos', ic: p.tipo === 'DIGITAL' ? '🛠️' : '📌', tit: p.titulo || p.texto,
      sub: `${p.tipo === 'DIGITAL' ? 'Digital' : 'Aviso'} · aberto há ${p.turnosAberto} turno${p.turnosAberto > 1 ? 's' : ''}${p.historico.length > 1 ? ` · ${p.historico.length - 1} atualização(ões)` : ''}`,
      abrir: () => abrirPendencia(p)
    });
  }
  for (const o of C.operacoes.filter(x => !x.horaFinal)) {
    itens.push({ grupo: 'operacoes', ic: '🚢', tit: `${o.rotuloTipo} · ${o.navio || 'navio?'}`, sub: `Em andamento desde ${o.horaInicial || '?'}${o.placa ? ' · ' + o.placa : ''}`, abrir: () => abrirOperacao(o) });
  }
  for (const o of emailsPendentes()) {
    const st = o.email?.status;
    const zap = o.email?.whatsappEm ? ' · minuta no seu WhatsApp' : '';
    const sub = st === 'ENVIADO' ? `Enviado ao líder ${quando(o.email.enviadoEm)} · falta encaminhar`
      : st === 'ERRO' ? `Falha no envio${zap} · toque para copiar` : st === 'SEM_CONTA' ? `Pronto para copiar${zap}` : 'Gerando…';
    itens.push({ grupo: 'emails', ic: '✉️', tit: `E-mail · ${o.rotuloTipo} · ${o.navio || ''}`, sub, erro: st === 'ERRO', abrir: () => abrirEmail(o) });
  }
  return itens;
}

function desenharPendencias() {
  const c = $('#aba-pendencias');
  if (!S.central) return;
  c.replaceChildren(cartaoPendencias());
  desenharTopo();
}

function cartaoPendencias() {
  const itens = itensPendentes();
  const filtros = [['todas', 'Todas'], ['avisos', 'Avisos'], ['digital', 'Digital'], ['operacoes', 'Operações'], ['emails', 'E-mails']];
  const visiveis = itens.filter(i => S.filtroPend === 'todas' || i.grupo === S.filtroPend);
  const concluidas = S.central.pendencias.filter(p => p.status === 'CONCLUIDA');
  return el('section', { class: 'cartao' },
    el('div', { class: 'cartao-topo' }, el('h2', { text: `Pendências (${itens.length})` }),
      el('div', { class: 'linha' },
        el('button', { class: 'btn pequeno', onclick: () => novaPendencia('AVISO') }, '+ Aviso'),
        el('button', { class: 'btn pequeno', onclick: () => novaPendencia('DIGITAL') }, '+ Digital'))),
    el('div', { class: 'filtros' }, filtros.map(([v, t]) => {
      const n = v === 'todas' ? itens.length : itens.filter(i => i.grupo === v).length;
      return el('button', { class: 'filtro' + (S.filtroPend === v ? ' ativo' : ''), onclick: () => { S.filtroPend = v; redesenharAba(); } }, `${t}${n ? ` (${n})` : ''}`);
    })),
    emailsPendentes().length && (S.filtroPend === 'emails' || S.filtroPend === 'todas')
      ? el('div', {}, el('button', { class: 'btn pequeno', onclick: copiarTodosEmails }, `📋 Copiar todos os e-mails (${emailsPendentes().length})`)) : null,
    visiveis.length
      ? el('div', { class: 'lista-pend' }, visiveis.map(i => el('button', { class: `pend${i.erro ? ' erro' : ''}`, onclick: i.abrir },
        el('span', { class: 'ic', text: i.ic }), el('span', { style: 'min-width:0' }, el('div', { class: 'tit', text: i.tit }), el('div', { class: 'sub', text: i.sub })), el('span', { class: 'seta', text: '›' }))))
      : el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '✅' }), 'Nada pendente aqui.'),
    concluidas.length ? el('details', {},
      el('summary', { class: 'mudo pequeno', style: 'cursor:pointer', text: `Concluídas nos últimos 7 dias (${concluidas.length})` }),
      el('div', { class: 'lista-pend', style: 'margin-top:8px' }, concluidas.map(p => el('button', { class: 'pend concluida', onclick: () => abrirPendencia(p) },
        el('span', { class: 'ic', text: '✓' }), el('span', { style: 'min-width:0' }, el('div', { class: 'tit', text: p.titulo }), el('div', { class: 'sub', text: `Resolvido por ${p.concluidoPor?.nome || '?'}: ${p.tratativa || ''}` })), el('span', { class: 'seta', text: '›' }))))) : null
  );
}

function novaPendencia(tipo, inicial = {}, entradaId = null) {
  const [c1, ti] = campoLinha('Título (assunto curto)', inicial.titulo || '', { placeholder: tipo === 'DIGITAL' ? 'Ex.: CÂMERA POSTE 12 OSCILANDO' : 'Ex.: BAGAGENS RETIDAS NA RFB – T-OIL', autofocus: true });
  const [c2, tx] = campoTexto('Descrição / o que acompanhar', inicial.texto || '');
  abrirModal(tipo === 'DIGITAL' ? '🛠️ Nova pendência da Digital' : '📌 Novo aviso', [
    inicial.citacao ? el('div', { class: 'citacao', text: inicial.citacao }) : null, c1, c2,
    el('p', { class: 'mudo pequeno', style: 'margin:0', text: tipo === 'DIGITAL' ? 'Fica em Pendências até ser concluída e entra na passagem da escala.' : 'Aparece na seção 5 do relatório até alguém concluir com a tratativa.' })
  ], botoesSalvar(async () => {
    await api('POST', '/api/pendencias', { tipo, titulo: ti.value, texto: tx.value, entradaId });
    fecharModal(); aviso('Pendência criada ✓'); await recarregarTudo();
  }, 'Criar'));
}

function abrirPendencia(p) {
  const aberta = p.status === 'ABERTA';
  const linhaTempo = el('div', { class: 'linha-tempo' }, p.historico.map(h => el('div', { class: `evento ${h.tipo}` },
    el('div', { class: 'meta', text: `${h.data} ${h.hora}h · ${h.por} · ${h.tipo === 'CRIACAO' ? 'criou' : h.tipo === 'CONCLUSAO' ? 'concluiu' : 'atualizou'}` }),
    h.texto ? el('div', { text: h.texto }) : null)));
  const acao = async (fn, msg) => { try { await fn(); fecharModal(); aviso(msg); await recarregarTudo(); } catch (e) { aviso(e.message, true); } };

  const atualizar = () => {
    const [c, t] = campoTexto('Nova atualização', '', { autofocus: true, placeholder: 'Ex.: Receita informou liberação prevista para amanhã às 10h.' });
    abrirModal(`Atualizar · ${p.titulo}`, [c], botoesSalvar(() => acao(() => api('POST', `/api/pendencias/${p.id}/atualizar`, { texto: t.value }), 'Atualização registrada ✓'), 'Registrar'));
  };
  const concluir = () => {
    const [c, t] = campoTexto('Como foi resolvido? (obrigatório)', '', { autofocus: true, linhas: 4, placeholder: 'Ex.: Receita liberou as bagagens às 21h; entregues ao agente Sr. X.' });
    const chk = el('input', { type: 'checkbox', checked: true });
    abrirModal(`Concluir · ${p.titulo}`, [c, el('label', { class: 'check' }, chk, 'Registrar também nas Atividades do turno')],
      botoesSalvar(() => {
        if (!t.value.trim()) { t.focus(); throw new Error('Informe como foi resolvido para concluir.'); }
        return acao(() => api('POST', `/api/pendencias/${p.id}/concluir`, { tratativa: t.value, registrarAtividade: chk.checked }), 'Pendência concluída ✓');
      }, '✓ Concluir', 'verde'));
  };
  const corrigir = () => {
    const [c1, ti] = campoLinha('Título', p.titulo);
    const [c2, tx] = campoTexto('Descrição', p.texto);
    const tipo = el('select', {}, el('option', { value: 'AVISO', text: 'Aviso (seção 5)' }), el('option', { value: 'DIGITAL', text: 'Pendência da Digital' }));
    tipo.value = p.tipo;
    const [c3, tr] = !aberta ? campoTexto('Como foi resolvido', p.tratativa || '', { linhas: 3 }) : [null, null];
    abrirModal('Corrigir pendência', [c1, c2, el('label', { class: 'campo' }, 'Tipo', tipo), c3],
      botoesSalvar(() => {
        if (!ti.value.trim()) throw new Error('O título não pode ficar vazio.');
        if (tr && !tr.value.trim()) throw new Error('Informe como foi resolvido.');
        return acao(() => api('PUT', `/api/pendencias/${p.id}`, { titulo: ti.value, texto: tx.value, tipo: tipo.value, ...(tr ? { tratativa: tr.value } : {}) }), 'Pendência corrigida ✓');
      }));
  };
  const apagar = async () => {
    if (await confirmar('Apagar esta pendência?', `"${p.titulo}" será removida de vez (fica registrado na auditoria). Para dar baixa normal, use "Concluir".`, 'Apagar', true))
      acao(() => api('POST', `/api/pendencias/${p.id}/excluir`), 'Pendência apagada');
  };

  abrirModal(p.titulo || 'Pendência', [
    el('div', { class: 'linha' },
      el('span', { class: `etiqueta ${p.tipo === 'DIGITAL' ? 'info' : 'atencao'}`, text: p.tipo === 'DIGITAL' ? '🛠️ Digital' : '📌 Aviso' }),
      el('span', { class: `etiqueta ${aberta ? '' : 'ok'}`, text: aberta ? `Aberta há ${p.turnosAberto} turno(s)` : 'Concluída' })),
    p.texto ? el('div', { class: 'citacao', text: p.texto }) : null,
    p.origem ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `Origem: ${p.origem}` }) : null,
    !aberta && p.tratativa ? el('div', { class: 'alertas', style: 'background:#0f2a1d;border-color:#1d4d33;color:#86efac' }, el('strong', { text: 'Como foi resolvido: ' }), p.tratativa) : null,
    el('h3', { text: 'Histórico' }), linhaTempo
  ], aberta ? [
    el('button', { class: 'btn fantasma pequeno', style: 'color:var(--vermelho)', onclick: apagar }, '🗑 Apagar'),
    el('button', { class: 'btn', onclick: corrigir }, '✏️ Corrigir'),
    el('button', { class: 'btn', onclick: atualizar }, 'Atualizar'),
    el('button', { class: 'btn verde', onclick: concluir }, '✓ Concluir')
  ] : [
    el('button', { class: 'btn fantasma pequeno', style: 'color:var(--vermelho)', onclick: apagar }, '🗑 Apagar'),
    el('button', { class: 'btn', onclick: corrigir }, '✏️ Corrigir'),
    el('button', { class: 'btn', onclick: () => acao(() => api('POST', `/api/pendencias/${p.id}/reabrir`), 'Reaberta') }, 'Reabrir')
  ]);
}

// ---------------------- Operações de bordo e e-mail ------------------
function abrirOperacao(o) {
  const linhas = [
    ['Tipo', o.rotuloTipo], ['Navio', o.navio], ['Terminal', o.terminal],
    o.tipo === 'TRIPULACAO' ? ['Tripulantes', `${o.movimento || ''} · ${o.quantidade || '?'}`] : null,
    ['Empresa', o.empresa], ['Motorista', o.responsavel], ['Ajudante', o.ajudante], ['Veículo', `${o.veiculo || ''} ${o.placa || ''}`.trim()],
    ['Entrada', o.horaInicial ? o.horaInicial + 'h' : '—'], ['Saída', o.horaFinal ? o.horaFinal + 'h' : 'aguardando']
  ].filter(x => x && x[1]);
  abrirModal(`${o.rotuloTipo} · ${o.navio || ''}`, [
    el('div', { class: 'grade-2' }, linhas.map(([k, v]) => el('div', {}, el('div', { class: 'mudo pequeno', text: k }), el('div', { text: v })))),
    o.origem?.autor ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `Informado por ${o.origem.autor} no grupo.` }) : null
  ], [
    el('button', { class: 'btn fantasma pequeno', onclick: async () => {
      if (await confirmar('Excluir operação?', `${o.rotuloTipo} · ${o.navio}`, 'Excluir', true)) {
        try { await api('POST', `/api/operacoes/${o.id}/excluir`); fecharModal(); await recarregarTudo(); } catch (e) { aviso(e.message, true); }
      }
    } }, 'Excluir'),
    el('button', { class: 'btn', onclick: () => abrirFormOperacao(o) }, 'Editar'),
    el('button', { class: 'btn', onclick: () => copiarEmailOperacao(o) }, '📋 Copiar e-mail'),
    el('button', { class: 'btn', onclick: () => abrirEmail(o) }, '✉️ Ver e-mail'),
    o.horaFinal ? null : el('button', { class: 'btn verde', onclick: () => registrarSaida(o) }, '🏁 Registrar saída')
  ]);
}

function registrarSaida(o, entrada = null, depois = null) {
  const [c, h] = campoLinha('Horário de saída', entrada?.campos?.hora || agoraBR().hora, { autofocus: true, placeholder: 'HH:MM' });
  abrirModal('🏁 Registrar saída', [el('div', { class: 'citacao', text: `${o.rotuloTipo} · ${o.navio || ''}${o.placa ? ' · ' + o.placa : ''}` }), c,
    el('p', { class: 'mudo pequeno', text: 'Com a saída registrada, o e-mail da operação é enviado ao líder de plantão.' })],
  botoesSalvar(async () => {
    await api('POST', `/api/operacoes/${o.id}/saida`, { hora: h.value, entradaId: entrada?.id });
    fecharModal(); aviso('Saída registrada ✓'); await recarregarTudo();
    if (depois) depois();
  }, 'Registrar', 'verde'));
}

async function abrirEmail(o) {
  try {
    const m = await api('GET', `/api/operacoes/${o.id}/email`);
    const [cPara, iPara] = campoLinha('Encaminhar para', m.para, { placeholder: 'Defina os destinatários em Configurações' });
    const [cCc, iCc] = campoLinha('Cópia (Cc)', m.cc);
    const [cAss, iAss] = campoLinha('Assunto', m.assunto);
    const [cCorpo, tCorpo] = campoTexto('Mensagem', m.corpo, { linhas: 14 });
    const st = m.status || {};
    const zap = st.whatsappEm ? ' A minuta também foi enviada no seu WhatsApp.' : '';
    const situacao = st.status === 'ENVIADO' ? `✓ Enviado para ${st.para}${st.cc ? ' (cc ' + st.cc + ')' : ''} ${quando(st.enviadoEm)}` :
      st.status === 'ERRO' ? `⚠ O envio automático falhou (${st.erro}).${zap} Copie abaixo e envie manualmente.` :
      !o.horaFinal ? 'Operação em andamento: o e-mail sai sozinho quando chegar a saída. Se precisar, já pode copiar.' :
      !m.emailAtivo ? `E-mail gerado automaticamente.${zap} Copie e envie pelo Outlook.` : 'Será enviado em instantes.';
    const q = (k, v) => v ? `${k}=${encodeURIComponent(v)}` : '';
    const marcar = campo => api('POST', `/api/operacoes/${o.id}/marcar`, { campo }).catch(() => {});
    abrirModal('✉️ E-mail da operação', [
      !o.horaFinal ? el('div', { class: 'alerta-saida' },
        el('span', { text: `⚠ Saída ainda não registrada (${o.rotuloTipo.toLowerCase()}). O horário final sai como "Em andamento".` }),
        el('button', { class: 'btn verde pequeno', onclick: () => { fecharModal(); registrarSaida(o); } }, '🏁 Registrar saída')) : null,
      o.horaFinal || st.status ? el('div', { class: `etiqueta ${st.status === 'ENVIADO' ? 'ok' : st.status === 'ERRO' ? 'urgente' : 'atencao'}`, style: 'white-space:normal' , text: situacao }) : null,
      cPara, cCc, cAss, cCorpo,
      el('p', { class: 'mudo pequeno', text: 'Confira, anexe as evidências e envie para a lista oficial. Depois toque em "Encaminhado".' })
    ], [
      el('button', { class: 'btn', onclick: () => copiar(iAss.value) }, '📋 Assunto'),
      el('button', { class: 'btn', onclick: () => copiar(tCorpo.value) }, '📋 Texto'),
      el('button', { class: 'btn', onclick: () => { marcar('abertoEm'); window.open(`https://outlook.office.com/mail/deeplink/compose?${[q('to', iPara.value), q('cc', iCc.value), q('subject', iAss.value), q('body', tCorpo.value)].filter(Boolean).join('&')}`, '_blank', 'noopener'); } }, '🌐 Outlook Web'),
      el('button', { class: 'btn', onclick: () => { marcar('abertoEm'); location.href = `mailto:${iPara.value.replace(/\s/g, '')}?${[q('cc', iCc.value), q('subject', iAss.value), q('body', tCorpo.value)].filter(Boolean).join('&')}`; } }, '📧 App de e-mail'),
      m.emailAtivo ? el('button', { class: 'btn', onclick: async () => { try { await api('POST', `/api/operacoes/${o.id}/enviar-email`); aviso('Reenviado ao líder ✓'); fecharModal(); recarregarTudo(); } catch (e) { aviso(e.message, true); } } }, '↻ Reenviar ao líder') : null,
      el('button', { class: 'btn verde', onclick: async () => { await marcar('encaminhadoEm'); fecharModal(); aviso('Marcado como encaminhado ✓'); recarregarTudo(); } }, '✓ Encaminhado')
    ]);
  } catch (e) { aviso(e.message, true); }
}

// =====================================================================
// PLANTÃO › E-MAILS (todas as operações de bordo do turno)
// =====================================================================
function situacaoEmail(o) {
  const st = o.email?.status;
  if (!o.horaFinal) return { txt: `Entrada ${o.horaInicial || '?'} · ⚠ saída não registrada`, alerta: true };
  if (o.email?.encaminhadoEm) return { txt: `Saída ${o.horaFinal} · ✓ encaminhado` };
  if (st === 'ENVIADO') return { txt: `Saída ${o.horaFinal} · enviado ao líder, falta encaminhar` };
  if (st === 'ERRO') return { txt: `Saída ${o.horaFinal} · envio falhou, copie e envie`, alerta: true };
  return { txt: `Saída ${o.horaFinal} · pronto para copiar${o.email?.whatsappEm ? ' (minuta no seu WhatsApp)' : ''}` };
}

function desenharEmails() {
  const c = $('#aba-emails');
  if (!S.central) return;
  const ops = [...S.central.operacoes].sort((a, b) => (b.horaInicial || b.horaFinal || '').localeCompare(a.horaInicial || a.horaFinal || ''));
  const filtros = [
    ['todos', 'Todos', () => true],
    ['semsaida', 'Sem saída', o => !o.horaFinal],
    ['encaminhar', 'A encaminhar', o => o.horaFinal && !o.email?.encaminhadoEm],
    ['encaminhados', 'Encaminhados', o => !!o.email?.encaminhadoEm]
  ];
  const atual = filtros.find(f => f[0] === S.filtroEmails) || filtros[0];
  const visiveis = ops.filter(atual[2]);
  c.replaceChildren(
    el('section', { class: 'cartao' },
      el('div', { class: 'cartao-topo' }, el('h2', { text: `E-mails de bordo (${ops.length})` }),
        el('div', { class: 'linha' },
          emailsPendentes().length ? el('button', { class: 'btn pequeno', onclick: copiarTodosEmails }, `📋 Copiar pendentes (${emailsPendentes().length})`) : null,
          el('button', { class: 'btn pequeno', onclick: () => abrirFormOperacao({ horaInicial: agoraBR().hora }) }, '+ Nova operação'))),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Um e-mail por navio. Toque para ver, copiar ou enviar. Sem saída, o e-mail já fica pronto com "Horário final: Em andamento".' }),
      el('div', { class: 'filtros' }, filtros.map(([v, t, fn]) => {
        const n = ops.filter(fn).length;
        return el('button', { class: 'filtro' + (atual[0] === v ? ' ativo' : ''), onclick: () => { S.filtroEmails = v; desenharEmails(); } }, `${t}${n ? ` (${n})` : ''}`);
      })),
      visiveis.length ? el('div', { class: 'lista-pend' }, visiveis.map(o => {
        const sit = situacaoEmail(o);
        return el('div', { class: `linha-op${sit.alerta ? ' alerta' : ''}`, role: 'button', tabindex: '0', onclick: ev => { if (!ev.target.closest('.acoes-op')) abrirEmail(o); } },
          el('span', { class: 'ic', text: o.tipo === 'TRIPULACAO' ? '🧑‍✈️' : '📦' }),
          el('span', { style: 'min-width:0' },
            el('div', { class: 'tit', text: `${o.rotuloTipo} · ${o.navio || 'navio?'}${o.terminal ? ' · ' + o.terminal : ''}` }),
            el('div', { class: 'sub', text: `${sit.txt}${o.placa ? ' · ' + o.placa : ''}` })),
          el('span', { class: 'linha acoes-op' },
            el('button', { class: 'btn pequeno', title: 'Copiar e-mail', onclick: () => copiarEmailOperacao(o) }, '📋'),
            !o.horaFinal ? el('button', { class: 'btn verde pequeno', title: 'Registrar saída', onclick: () => registrarSaida(o) }, '🏁') : null));
      })) : el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '✉️' }), atual[0] === 'todos' ? 'Nenhuma operação de bordo neste turno.' : 'Nada aqui.')));
}

async function copiarEmailOperacao(o) {
  try {
    const m = await api('GET', `/api/operacoes/${o.id}/email`);
    await copiar(`ASSUNTO: ${m.assunto}\n\n${m.corpo}`);
    aviso(o.horaFinal ? 'E-mail copiado ✓' : 'E-mail copiado ✓ (horário final: em andamento)');
  } catch (e) { aviso(e.message, true); }
}

async function copiarTodosEmails() {
  try {
    const { minutas, para, cc } = await api('GET', '/api/emails/pendentes');
    if (!minutas.length) return aviso('Nenhum e-mail pendente.');
    const sep = '\n\n————————————————————\n\n';
    const texto = minutas.map((m, i) => `E-MAIL ${i + 1} de ${minutas.length}\nPARA: ${para || '(lista oficial)'}${cc ? '\nCC: ' + cc : ''}\nASSUNTO: ${m.assunto}\n\n${m.corpo}`).join(sep);
    await copiar(texto);
    aviso(`${minutas.length} e-mail(s) copiado(s) ✓`);
  } catch (e) { aviso(e.message, true); }
}

// Formulário de operação: criando (vários navios → um e-mail por navio) ou editando
function abrirFormOperacao(op = {}, ctx = {}) {
  const editando = !!op.id;
  const v = { ...op };
  const tipos = S.meta.tipos;
  const tipo = el('select', {}, Object.entries(tipos).map(([k, t]) => el('option', { value: k, text: t.rotulo })));
  tipo.value = v.tipo || 'RANCHO';
  const terminal = el('select', {}, ['', 'T-ORE', 'T-OIL'].map(t => el('option', { value: t, text: t || '—' })));
  terminal.value = v.terminal || '';
  const movimento = el('select', {}, ['', ...S.meta.movimentos].map(t => el('option', { value: t, text: t || '—' })));
  movimento.value = v.movimento || '';

  const L = (r, k, ph) => campoLinha(r, v[k], { placeholder: ph });
  const naviosIniciais = ctx.navios || (v.navio ? [v.navio] : []);
  const [cNavio, iNavio] = editando ? L('Navio', 'navio') : campoTexto('Navio(s) — um por linha · cada navio gera o seu e-mail', naviosIniciais.join('\n'), { linhas: 2, placeholder: 'BARCELONA SPIRIT' });
  const [cEmp, iEmp] = L('Empresa / agência / fornecedor', 'empresa');
  const [cResp, iResp] = L('Motorista / agente', 'responsavel');
  const [cAju, iAju] = L('Ajudante', 'ajudante');
  const [cVei, iVei] = L('Veículo', 'veiculo', 'CAMINHÃO, VAN…');
  const [cPla, iPla] = L('Placa', 'placa', 'ABC-1D23');
  const [cQtd, iQtd] = L('Quantos tripulantes', 'quantidade', '03');
  const [cHi, iHi] = L('Horário inicial', 'horaInicial', 'HH:MM');
  const [cHf, iHf] = L('Horário final (saída)', 'horaFinal', 'vazio = em andamento');
  const autoridade = el('input', { type: 'text', value: v.autoridades || tipos[tipo.value]?.autoridade || '', placeholder: tipos[tipo.value]?.autoridade });
  let autoridadePadrao = tipos[tipo.value]?.autoridade || '';
  const [cObs, iObs] = campoTexto('Observações', v.observacoes, { linhas: 2, placeholder: 'S/A' });

  const tripulacao = el('div', { class: 'grade-2' }, cQtd, el('label', { class: 'campo' }, 'Movimento', movimento));
  const ajustar = () => {
    tripulacao.hidden = tipo.value !== 'TRIPULACAO';
    const nova = tipos[tipo.value]?.autoridade || '';
    if (!autoridade.value.trim() || autoridade.value === autoridadePadrao) autoridade.value = nova;
    autoridadePadrao = nova; autoridade.placeholder = nova;
  };
  tipo.addEventListener('change', ajustar); ajustar();

  let chkAtiv = null, txtAtiv = null;
  const extras = [];
  if (ctx.item) {
    chkAtiv = el('input', { type: 'checkbox', checked: true });
    [, txtAtiv] = campoTexto('', ctx.atividade || ctx.item.texto, { linhas: 2 });
    extras.push(el('label', { class: 'check' }, chkAtiv, 'Registrar também nas Atividades (seção 4)'), txtAtiv);
    chkAtiv.addEventListener('change', () => { txtAtiv.hidden = !chkAtiv.checked; });
  }

  const dadosForm = () => ({
    tipo: tipo.value, terminal: terminal.value, quantidade: iQtd.value, movimento: movimento.value,
    empresa: iEmp.value, responsavel: iResp.value, ajudante: iAju.value, veiculo: iVei.value, placa: iPla.value,
    horaInicial: iHi.value, horaFinal: iHf.value, autoridades: autoridade.value, observacoes: iObs.value
  });
  const copiarDoForm = async () => {
    try {
      const navios = iNavio.value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!navios.length) return aviso('Informe o navio.', true);
      const minutas = [];
      for (const n of navios) minutas.push(await api('POST', '/api/operacoes/minuta', { ...dadosForm(), navio: n }));
      await copiar(minutas.map(m => `ASSUNTO: ${m.assunto}\n\n${m.corpo}`).join('\n\n————————————————————\n\n'));
      aviso(navios.length > 1 ? `${navios.length} e-mails copiados ✓` : 'E-mail copiado ✓');
    } catch (e) { aviso(e.message, true); }
  };

  abrirModal(editando ? 'Editar operação de bordo' : '✉️ Operação de bordo', [
    ctx.citacao || null,
    el('div', { class: 'grade-2' }, el('label', { class: 'campo' }, 'Tipo', tipo), el('label', { class: 'campo' }, 'Terminal', terminal)),
    cNavio, tripulacao,
    el('div', { class: 'grade-2' }, cHi, cHf),
    cEmp, el('div', { class: 'grade-2' }, cResp, cAju),
    el('div', { class: 'grade-2' }, cVei, cPla),
    el('label', { class: 'campo' }, 'Autorizado por (Autoridades)', autoridade),
    cObs, ...extras,
    el('div', { class: 'linha' }, el('button', { class: 'btn pequeno', onclick: copiarDoForm }, '📋 Copiar e-mail agora')),
    el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'O e-mail sai sozinho quando houver horário de saída. Enquanto isso, você pode copiar e enviar manualmente.' })
  ], botoesSalvar(async () => {
    const dados = dadosForm();
    if (editando) {
      await api('PUT', `/api/operacoes/${op.id}`, { ...dados, navio: iNavio.value });
    } else {
      const navios = iNavio.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!navios.length) throw new Error('Informe o navio.');
      await api('POST', '/api/operacoes', {
        operacoes: navios.map(n => ({ ...dados, navio: n })),
        atividadeTexto: chkAtiv?.checked ? txtAtiv.value.trim() : '',
        entradaId: ctx.item?.id || null, autor: ctx.item?.autor || ''
      });
    }
    fecharModal(); aviso(editando ? 'Operação atualizada ✓' : 'Operação registrada ✓');
    await recarregarTudo();
  }, editando ? 'Salvar' : 'Registrar'));
}

// =====================================================================
// ABA 2 · ENTRADA
// =====================================================================
function desenharEntrada() {
  const c = $('#aba-entrada');
  const cont = s => S.entrada.filter(i => i.status === s).length;
  const filtros = [['pendente', `Pendentes (${cont('pendente')})`], ['usado', 'Tratadas'], ['ignorado', 'Ignoradas'], ['todas', 'Todas']];
  c.replaceChildren(
    el('div', { class: 'filtros' }, filtros.map(([v, t]) => el('button', { class: 'filtro' + (S.filtroEntrada === v ? ' ativo' : ''), onclick: () => { S.filtroEntrada = v; desenharEntrada(); } }, t))),
    el('input', { type: 'search', placeholder: 'Buscar por navio, placa, nome…', value: S.busca, oninput: e => { S.busca = e.target.value; desenharListaEntrada(); } }),
    el('div', { id: 'lista-entrada', class: 'lista' })
  );
  desenharListaEntrada();
}

function desenharListaEntrada() {
  const box = $('#lista-entrada');
  if (!box) return;
  const termo = semAcento(S.busca).toLowerCase().trim();
  const itens = S.entrada
    .filter(i => S.filtroEntrada === 'todas' || i.status === S.filtroEntrada)
    .filter(i => !termo || semAcento(`${i.texto} ${i.autor} ${i.grupoNome}`).toLowerCase().includes(termo))
    .sort((a, b) => (S.filtroEntrada === 'pendente' ? (b.urgente - a.urgente) : 0) || b.ts - a.ts);
  if (!itens.length) {
    const msg = S.filtroEntrada === 'pendente' ? 'Nada pendente. Mensagens no formato padrão (provisão, tripulantes) são registradas sozinhas e aparecem em "Tratadas".' : 'Nenhuma mensagem aqui.';
    box.replaceChildren(el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '📭' }), msg));
    return;
  }
  box.replaceChildren(...itens.slice(0, 150).map(cartaoMensagem));
}

const operacoesAbertas = () => (S.central?.operacoes || []).filter(o => !o.horaFinal);

function cartaoMensagem(item) {
  const hoje = agoraBR().data;
  let sug = item.sugestao in DESTINOS ? item.sugestao : 'ATIVIDADE';
  if (sug === 'SAIDA' && !operacoesAbertas().length) sug = 'ATIVIDADE';
  const acoes = [];
  if (item.status === 'pendente') {
    acoes.push(
      el('button', { class: 'btn fantasma pequeno', onclick: () => marcarItem(item, 'ignorado') }, 'Ignorar'),
      el('button', { class: 'btn pequeno', onclick: () => escolherDestino(item) }, 'Outro destino'),
      el('button', { class: 'btn primario pequeno', onclick: () => abrirDestino(item, sug) }, `${DESTINOS[sug].ic} ${DESTINOS[sug].rotulo}`));
  } else if (item.status === 'usado') {
    const ops = (S.central?.operacoes || []).filter(o => o.origem?.entradaId === item.id);
    if (ops.length) acoes.push(
      el('button', { class: 'btn pequeno', onclick: () => copiarEmailOperacao(ops[0]) }, '📋 Copiar e-mail'),
      el('button', { class: 'btn primario pequeno', onclick: () => ops.length === 1 ? abrirEmail(ops[0]) : abrirOperacao(ops[0]) }, ops.length === 1 ? '✉️ Ver e-mail' : `🚢 ${ops.length} operações`));
    acoes.push(el('button', { class: 'btn fantasma pequeno', onclick: () => marcarItem(item, 'pendente') }, 'Voltar p/ pendentes'),
      el('button', { class: 'btn pequeno', onclick: () => escolherDestino(item) }, 'Usar de novo'));
  } else {
    acoes.push(el('button', { class: 'btn pequeno', onclick: () => marcarItem(item, 'pendente') }, 'Restaurar'));
  }
  return el('article', { class: `msg${item.urgente && item.status === 'pendente' ? ' urgente' : ''}${item.status !== 'pendente' ? ' tratada' : ''}` },
    el('div', { class: 'msg-topo' },
      el('span', {}, el('strong', { text: item.autor || 'Sem nome' }), item.grupoNome ? ` · ${item.grupoNome}` : ''),
      el('span', { text: `${item.data !== hoje ? item.data.slice(0, 5) + ' ' : ''}${item.hora}` })),
    (item.urgente || item.editado || item.destino) ? el('div', { class: 'linha' },
      item.urgente ? el('span', { class: 'etiqueta urgente', text: '🚨 Possível emergência' }) : null,
      item.editado ? el('span', { class: 'etiqueta', text: 'editada' }) : null,
      item.destino ? el('span', { class: 'etiqueta ok', text: '→ ' + item.destino }) : null) : null,
    el('div', { class: 'msg-texto', text: item.texto }),
    el('div', { class: 'msg-acoes' }, acoes));
}

async function marcarItem(item, status, destino) {
  try {
    const r = await api('POST', `/api/entrada/${encodeURIComponent(item.id)}`, { status, destino });
    Object.assign(item, r.item);
    S.estado.pendentesEntrada = S.entrada.filter(i => i.status === 'pendente').length;
    S.estado.urgentes = S.entrada.filter(i => i.status === 'pendente' && i.urgente).length;
    desenharTopo();
    if (S.aba === 'entrada') desenharEntrada();
  } catch (e) { aviso(e.message, true); }
}

function escolherDestino(item) {
  const opcoes = Object.entries(DESTINOS).filter(([k]) => k !== 'SAIDA' || operacoesAbertas().length)
    .map(([k, d]) => el('button', { class: 'opcao-destino', onclick: () => abrirDestino(item, k) },
      el('span', { class: 'ic', text: d.ic }), el('span', {}, el('strong', { text: d.rotulo }), el('small', { text: d.desc }))));
  abrirModal('Para onde vai esta informação?', [el('div', { class: 'citacao', text: item.texto }), el('div', { class: 'opcoes-destino' }, opcoes)]);
}

function abrirDestino(item, destino) {
  const citacao = el('div', { class: 'citacao', text: `${item.autor} · ${item.hora}\n${item.texto}` });
  const concluir = async rotulo => { fecharModal(); await marcarItem(item, 'usado', rotulo); aviso(`Enviado para ${rotulo} ✓`); await recarregarTudo(); };

  if (destino === 'ATIVIDADE' || destino === 'OCORRENCIA') {
    const chave = destino === 'ATIVIDADE' ? 'atividades' : 'ocorrencias';
    const [c, t] = campoTexto(destino === 'ATIVIDADE' ? 'Texto na seção 4' : 'Texto na seção 7', `${item.hora}h ${item.texto.replace(/\s*\n\s*/g, ' ')}`, { autofocus: true });
    return abrirModal(destino === 'ATIVIDADE' ? '📝 Nova atividade' : '🚨 Nova ocorrência', [citacao, c], botoesSalvar(async () => {
      if (!t.value.trim()) throw new Error('Escreva o texto.');
      await alterarFicha(f => f[chave].push({ id: uid(), texto: t.value.trim() }));
      await concluir(DESTINOS[destino].rotulo);
    }, 'Adicionar'));
  }
  if (destino === 'AVISO' || destino === 'DIGITAL') return novaPendencia(destino, { texto: item.texto, citacao: `${item.autor} · ${item.hora}\n${item.texto}` }, item.id);
  if (destino === 'NAVIO') {
    const term = el('select', {}, el('option', { value: 'tore', text: 'T-ORE' }), el('option', { value: 'toil', text: 'T-OIL' }));
    term.value = item.campos?.terminal === 'T-OIL' ? 'toil' : 'tore';
    const lista = () => S.ficha.navios?.[term.value] || [];
    const sel = el('select');
    const preencher = () => {
      sel.replaceChildren(el('option', { value: '__novo', text: '+ Novo navio' }), ...lista().map(n => el('option', { value: n.id, text: n.navio || '(sem nome)' })));
      const alvo = semAcento(item.campos?.navio || item.texto).toUpperCase();
      const achado = lista().find(n => n.navio && alvo.includes(semAcento(n.navio).toUpperCase().replace(/^MV\s*-?\s*/, '')));
      sel.value = achado ? achado.id : '__novo';
    };
    term.addEventListener('change', preencher); preencher();
    const [cNome, iNome] = campoLinha('Nome do navio (se for novo)', item.campos?.navio || '');
    const semNome = () => {
      const n = lista().find(x => x.id === sel.value)?.navio || iNome.value || '';
      const nome = semAcento(n).toUpperCase().replace(/^MV\s*-?\s*/, '').trim();
      let t = item.texto.replace(/\s*\n\s*/g, ' ');
      if (nome) t = t.replace(new RegExp('^\\s*(MV\\s*-?\\s*)?' + nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–:,.]?\\s*', 'i'), '');
      return t.charAt(0).toUpperCase() + t.slice(1);
    };
    const [cLinha, tLinha] = campoTexto('Linha a registrar', semNome(), { linhas: 2 });
    sel.addEventListener('change', () => { tLinha.value = semNome(); });
    return abrirModal('🚢 Movimentação de navios', [citacao, el('div', { class: 'grade-2' }, el('label', { class: 'campo' }, 'Terminal', term), el('label', { class: 'campo' }, 'Navio', sel)), cNome, cLinha], botoesSalvar(async () => {
      await alterarFicha(f => {
        f.navios[term.value] = f.navios[term.value] || [];
        let n = f.navios[term.value].find(x => x.id === sel.value);
        if (!n) { n = { id: uid(), navio: iNome.value.trim().toUpperCase(), linhas: [] }; f.navios[term.value].push(n); }
        n.linhas.push(tLinha.value.trim());
      });
      await concluir(`Navios ${term.value === 'tore' ? 'T-ORE' : 'T-OIL'}`);
    }, 'Salvar'));
  }
  if (destino === 'OPERACAO') {
    const r = item.rascunhos?.length ? item.rascunhos : [{ tipo: 'RANCHO', horaInicial: item.campos?.hora || item.hora, placa: item.campos?.placa, terminal: item.campos?.terminal, navio: item.campos?.navio }];
    return abrirFormOperacao({ ...r[0], navio: undefined }, { item, citacao, navios: r.map(x => x.navio).filter(Boolean), atividade: item.atividade || `${item.hora}h ${item.texto.replace(/\s*\n\s*/g, ' ')}` });
  }
  if (destino === 'SAIDA') {
    const abertas = operacoesAbertas();
    const placa = (item.campos?.placa || '').replace('-', '');
    const casada = abertas.find(o => placa && (o.placa || '').replace('-', '') === placa);
    if (casada) return registrarSaida(casada, item);
    const sel = el('select', {}, abertas.map(o => el('option', { value: o.id, text: `${o.rotuloTipo} · ${o.navio || '—'}${o.placa ? ' · ' + o.placa : ''}` })));
    return abrirModal('🏁 Qual operação saiu?', [citacao, el('label', { class: 'campo' }, 'Operação', sel)], [
      el('button', { class: 'btn primario', onclick: () => registrarSaida(abertas.find(o => o.id === sel.value), item) }, 'Continuar')]);
  }
}

// =====================================================================
// ABA 3 · RELATÓRIO (8 seções)
// =====================================================================
function obter(obj, caminho) { return caminho.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function definir(obj, caminho, valor) {
  const ks = caminho.split('.'); const ult = ks.pop();
  const alvo = ks.reduce((o, k) => (o[k] = o[k] || {}), obj);
  alvo[ult] = valor;
}

function campo(rotulo, caminho, { tipo = 'text', multilinha = false, linhas = 2, placeholder } = {}) {
  const valor = obter(S.ficha, caminho);
  const aoDigitar = e => {
    let v = e.target.value;
    if (tipo === 'number') v = v === '' ? null : Number(v);
    definir(S.ficha, caminho, v);
    if (multilinha) autoAltura(e.target);
    if (caminho.startsWith('vtr.km')) atualizarKmRodados();
    agendarSalvar();
  };
  const entrada = multilinha
    ? el('textarea', { rows: linhas, value: valor ?? '', placeholder, oninput: aoDigitar })
    : el('input', { type: tipo, value: valor ?? '', placeholder, oninput: aoDigitar, inputmode: tipo === 'number' ? 'numeric' : undefined });
  return rotulo ? el('label', { class: 'campo' }, rotulo, entrada) : entrada;
}

function secao(num, titulo, ...conteudo) {
  return el('section', { class: 'cartao' }, el('h2', {}, num ? el('span', { class: 'secao-num', text: num }) : null, titulo,
    num ? el('span', { class: 'st-sec', 'data-sec': num }) : null), ...conteudo);
}

// Situação de cada seção do relatório (✓ pronta / ⚠ falta)
function situacaoSecoes() {
  const f = S.ficha || {};
  const cheio = v => v !== null && v !== undefined && String(v).trim() !== '';
  const eq = f.equipes || {};
  return {
    1: cheio(f.efetivo) || 'Preencha o efetivo',
    2: (cheio(f.vtr?.kmInicial) && cheio(f.vtr?.kmFinal) && Number(f.vtr.kmFinal) >= Number(f.vtr.kmInicial)) || 'KM inicial e final',
    3: (cheio(f.sistemas?.ocrAssertividade) && cheio(f.sistemas?.ocrLeituras)) || 'OCR não preenchido',
    4: (f.atividades || []).some(a => cheio(a.texto)) || 'Nenhuma atividade',
    5: true, 6: true, 7: true,
    8: (eq.modo === 'ESCALA' || cheio(eq.assumindo)) || 'Escolha a equipe que entra'
  };
}
function atualizarProgresso() {
  const st = situacaoSecoes();
  const ok = Object.values(st).filter(v => v === true).length;
  document.querySelectorAll('.st-sec').forEach(x => {
    const v = st[x.dataset.sec];
    x.className = 'st-sec ' + (v === true ? 'ok' : 'falta');
    x.textContent = v === true ? '✓' : '⚠ ' + v;
  });
  const b = $('#progresso-rel');
  if (b) { b.querySelector('strong').textContent = `${ok} de 8 seções prontas`; b.querySelector('.barra span').style.width = `${ok / 8 * 100}%`; }
}

function editorLista(chave, { vazio, placeholder, rotuloNovo }) {
  const box = el('div', { class: 'lista' });
  const desenhar = focarUltimo => {
    const arr = S.ficha[chave] = S.ficha[chave] || [];
    box.replaceChildren();
    if (!arr.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: vazio }));
    arr.forEach((it, i) => {
      const t = el('textarea', { rows: 1, value: it.texto, placeholder, oninput: e => { it.texto = e.target.value; autoAltura(e.target); agendarSalvar(); } });
      const mover = d => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; desenhar(); agendarSalvar(); };
      const opsDaLinha = (it.opIds || []).map(id => (S.central?.operacoes || []).find(o => o.id === id)).filter(Boolean);
      const abrirEmailsDaLinha = () => opsDaLinha.length === 1 ? abrirEmail(opsDaLinha[0])
        : abrirModal('E-mails desta atividade', [el('div', { class: 'lista-pend' }, opsDaLinha.map(o => el('button', { class: 'pend', onclick: () => { fecharModal(); abrirEmail(o); } },
          el('span', { class: 'ic', text: '✉️' }), el('span', {}, el('div', { class: 'tit', text: `${o.rotuloTipo} · ${o.navio}` }), el('div', { class: 'sub', text: situacaoEmail(o).txt })), el('span', { class: 'seta', text: '›' }))))]);
      box.append(el('div', { class: 'item-lista' }, t, el('div', { class: 'ferramentas' },
        opsDaLinha.length ? el('button', { title: 'Abrir e-mail', 'aria-label': 'Abrir e-mail', onclick: abrirEmailsDaLinha }, '✉️') : null,
        el('button', { title: 'Subir', 'aria-label': 'Subir', onclick: () => mover(-1) }, '↑'),
        el('button', { title: 'Descer', 'aria-label': 'Descer', onclick: () => mover(1) }, '↓'),
        el('button', { title: 'Remover', 'aria-label': 'Remover', onclick: () => { arr.splice(i, 1); desenhar(); agendarSalvar(); } }, '✕'))));
    });
    requestAnimationFrame(() => {
      box.querySelectorAll('textarea').forEach(autoAltura);
      if (focarUltimo) { const ts = box.querySelectorAll('textarea'); ts[ts.length - 1]?.focus(); }
    });
  };
  desenhar();
  return el('div', { class: 'lista' }, box,
    el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { S.ficha[chave].push({ id: uid(), texto: `${agoraBR().hora}h ` }); desenhar(true); agendarSalvar(); } }, '+ ' + rotuloNovo)));
}

function editorNavios(chave) {
  const box = el('div', { class: 'lista' });
  const desenhar = focar => {
    S.ficha.navios = S.ficha.navios || { tore: [], toil: [] };
    const arr = S.ficha.navios[chave] = S.ficha.navios[chave] || [];
    box.replaceChildren();
    if (!arr.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Sem navios (sai "✓ S/A").' }));
    arr.forEach((n, i) => {
      const nome = el('input', { type: 'text', value: n.navio || '', placeholder: 'NOME DO NAVIO', oninput: e => { n.navio = e.target.value.toUpperCase(); agendarSalvar(); } });
      const linhas = el('textarea', { rows: 2, value: (n.linhas || []).join('\n'), placeholder: 'Uma linha por informação (ex.: Atracado às 08:54.)', oninput: e => { n.linhas = e.target.value.split('\n'); autoAltura(e.target); agendarSalvar(); } });
      box.append(el('div', { class: 'navio-ed' },
        el('div', { class: 'linha' }, nome, el('button', { class: 'btn-icone', title: 'Remover navio', onclick: () => { arr.splice(i, 1); desenhar(); agendarSalvar(); } }, '✕')),
        linhas));
    });
    requestAnimationFrame(() => { box.querySelectorAll('textarea').forEach(autoAltura); if (focar) { const ins = box.querySelectorAll('input'); ins[ins.length - 1]?.focus(); } });
  };
  desenhar();
  return el('div', { class: 'lista' }, box, el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { S.ficha.navios[chave].push({ id: uid(), navio: '', linhas: [] }); desenhar(true); } }, '+ Navio')));
}

function listaAvisosRelatorio() {
  const box = el('div', { class: 'lista-pend' });
  if (!S.avisos.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhum aviso em aberto (sai "✓ S/A").' }));
  S.avisos.forEach((p, i) => box.append(el('button', { class: 'pend', onclick: () => abrirPendencia(p) },
    el('span', { class: 'ic mudo', text: `5.${i + 1}` }), el('span', { style: 'min-width:0' }, el('div', { class: 'tit', text: p.titulo }), el('div', { class: 'sub', text: p.texto || '' })), el('span', { class: 'seta', text: '›' }))));
  return el('div', { class: 'lista' }, box,
    el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Avisos são pendências: atualize ou conclua (com tratativa) tocando neles. Os abertos passam para o próximo turno.' }),
    el('div', {}, el('button', { class: 'btn pequeno', onclick: () => novaPendencia('AVISO') }, '+ Novo aviso')));
}

function listaOperacoes() {
  const ops = S.operacoes || [];
  if (!ops.length) return el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhuma operação no turno.' });
  return el('div', { class: 'lista-pend' }, ops.map(o => {
    const st = !o.horaFinal ? 'Em andamento' : o.email?.encaminhadoEm ? 'Encaminhado ✓' : o.email?.status === 'ENVIADO' ? 'E-mail enviado ao líder' : o.email?.status === 'ERRO' ? 'Falha no e-mail' : 'E-mail pendente';
    return el('button', { class: `pend${o.email?.status === 'ERRO' ? ' erro' : ''}`, onclick: () => abrirOperacao(o) },
      el('span', { class: 'ic', text: o.horaFinal ? '✉️' : '🚢' }),
      el('span', { style: 'min-width:0' }, el('div', { class: 'tit', text: `${o.rotuloTipo} · ${o.navio || '?'}` }), el('div', { class: 'sub', text: `${o.horaInicial || '—'} → ${o.horaFinal || '…'} · ${st}` })),
      el('span', { class: 'seta', text: '›' }));
  }));
}

function atualizarKmRodados() {
  const e = $('#km-rodados'); if (!e) return;
  const ki = S.ficha.vtr?.kmInicial, kf = S.ficha.vtr?.kmFinal;
  e.textContent = (ki != null && kf != null) ? `Rodou ${kf - ki} km no turno` : '';
}

function desenharConferencia() {
  const e = $('#bloco-conferencia'); if (!e) return;
  e.hidden = !S.conferencia.length;
  e.replaceChildren(...S.conferencia.map(a => el('div', { text: '• ' + a })));
}

// ----------------------- Seção 8 · Passagem de turno -----------------
const juntarNomes = l => (l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}` : (l[0] || ''));
const PARTIC = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const nomeProprio = n => {
  const orig = String(n || '').trim().replace(/\s+/g, ' '), misto = /[a-zà-ÿ]/.test(orig);
  return orig.split(' ').map((w, i) => {
    if (misto && w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
    const p = w.toLowerCase();
    return (i && PARTIC.has(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' ');
};
const separarNomes = t => (!t || /conforme\s+escala/i.test(t)) ? [] : String(t).split(/\s*(?:,|;|\/|\n|\s+e\s+)\s*/i).map(nomeProprio).filter(n => n.length >= 2);

async function carregarNomesEquipe() {
  try { S.nomesEquipe = (await api('GET', '/api/equipe')).nomes; } catch (_) { S.nomesEquipe = S.nomesEquipe || []; }
}

const CORES_EQUIPE = { azul: '#3b82f6', verde: '#22c55e', vermelha: '#ef4444', amarela: '#eab308', laranja: '#f97316', roxa: '#a855f7', cinza: '#94a3b8' };
async function carregarEquipes() {
  try { const r = await api('GET', '/api/equipes'); S.equipes = r.equipes; S.lideresDisponiveis = r.lideres; } catch (_) { S.equipes = S.equipes || []; }
}

function editorEquipes() {
  const box = el('div', { class: 'equipes' });
  if (!S.nomesEquipe || !S.equipes) Promise.all([carregarNomesEquipe(), carregarEquipes()]).then(() => render());
  const eq = () => {
    const e = S.ficha.equipes || {};
    if (!e.modo || ['NOMES', 'HERANCA'].includes(e.modo)) e.modo = /conforme/i.test(`${e.saindo}${e.assumindo}`) && !e.saindoLista?.length ? 'ESCALA' : 'EQUIPES';
    e.saindoLista = e.saindoLista || separarNomes(e.saindo);
    e.assumindoLista = e.assumindoLista || separarNomes(e.assumindo);
    S.ficha.equipes = e;
    return e;
  };
  const salvar = () => { const e = eq(); e.saindo = juntarNomes(e.saindoLista); e.assumindo = juntarNomes(e.assumindoLista); agendarSalvar(); render(); };
  const equipe = id => (S.equipes || []).find(x => x.id === id);

  const escolherModo = modo => {
    const e = eq();
    if (modo === 'ESCALA') Object.assign(e, { modo, saindo: 'Conforme escala', assumindo: 'Conforme escala', saindoLista: [], assumindoLista: [], saindoEquipeId: null, assumindoEquipeId: null });
    else Object.assign(e, { modo });
    if (modo === 'EQUIPES') {
      if (/conforme/i.test(e.saindo || '')) { e.saindo = ''; e.saindoLista = []; }
      if (/conforme/i.test(e.assumindo || '')) { e.assumindo = ''; e.assumindoLista = []; }
    }
    if (modo !== 'MANUAL') return salvar();
    agendarSalvar(); render();
  };

  const escolherEquipe = (lado, id) => {
    const e = eq(), q = equipe(id);
    if (!q) return;
    e[lado + 'EquipeId'] = id;
    e[lado + 'Lista'] = [...q.membros];
    salvar();
  };

  // tocar num nome: substituir (férias) ou tirar só deste relatório
  const tocarMembro = (lado, nome) => {
    const e = eq();
    const usados = new Set([...e.saindoLista, ...e.assumindoLista]);
    const livres = (S.nomesEquipe || []).filter(n => !usados.has(n));
    const trocar = novo => {
      const k = lado + 'Lista';
      e[k] = e[k].map(n => (n === nome ? novoNome(novo) : n));
      fecharModal(); salvar(); aviso(`${nome} → ${novoNome(novo)}`);
    };
    const novoNome = n => nomeProprio(n);
    const [cOutro, iOutro] = campoLinha('Ou digite o nome do substituto', '', { placeholder: 'Ex.: Marcos Bruno' });
    abrirModal(`Substituir ${nome}`, [
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Vale só para este relatório; o cadastro da equipe não muda.' }),
      livres.length ? el('div', { class: 'chips' }, livres.map(n => el('button', { class: 'chip', onclick: () => trocar(n) }, n))) : el('p', { class: 'mudo pequeno', text: 'Nenhum outro nome na lista.' }),
      cOutro
    ], [
      el('button', { class: 'btn fantasma', style: 'color:var(--vermelho)', onclick: () => { e[lado + 'Lista'] = e[lado + 'Lista'].filter(n => n !== nome); fecharModal(); salvar(); } }, 'Tirar deste relatório'),
      el('button', { class: 'btn primario', onclick: async () => {
        if (!iOutro.value.trim()) return aviso('Escolha um nome ou digite o substituto.', true);
        try { S.nomesEquipe = (await api('POST', '/api/equipe', { nome: iOutro.value })).nomes; } catch (_) {}
        trocar(iOutro.value);
      } }, 'Substituir')
    ]);
  };

  const adicionarPessoa = lado => {
    const e = eq();
    const usados = new Set([...e.saindoLista, ...e.assumindoLista]);
    const livres = (S.nomesEquipe || []).filter(n => !usados.has(n));
    const [c, i] = campoLinha('Ou digite o nome', '', { placeholder: 'Ex.: Wallace Ferroport' });
    const add = n => { e[lado + 'Lista'] = [...e[lado + 'Lista'], nomeProprio(n)]; fecharModal(); salvar(); };
    abrirModal('Adicionar pessoa', [
      livres.length ? el('div', { class: 'chips' }, livres.map(n => el('button', { class: 'chip', onclick: () => add(n) }, n))) : null, c
    ], [el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'), el('button', { class: 'btn primario', onclick: async () => {
      if (!i.value.trim()) return aviso('Digite o nome.', true);
      try { S.nomesEquipe = (await api('POST', '/api/equipe', { nome: i.value })).nomes; } catch (_) {}
      add(i.value);
    } }, 'Adicionar')]);
  };

  const membros = (lado, editavel = true) => {
    const e = eq();
    return el('div', { class: 'chips' },
      e[lado + 'Lista'].map(n => el('button', { class: 'chip ativo', title: 'Toque para substituir', onclick: () => editavel && tocarMembro(lado, n) }, `${n} ⇄`)),
      editavel ? el('button', { class: 'chip novo', onclick: () => adicionarPessoa(lado) }, '+ Pessoa') : null);
  };

  const botoesEquipes = (lado, excluirId) => el('div', { class: 'chips' },
    (S.equipes || []).filter(q => q.id !== excluirId).map(q => el('button', { class: `equipe-btn${eq()[lado + 'EquipeId'] === q.id ? ' ativo' : ''}`, onclick: () => escolherEquipe(lado, q.id) },
      el('strong', {}, el('span', { class: 'ponto-cor', style: `background:${CORES_EQUIPE[q.cor] || CORES_EQUIPE.azul}` }), q.nome),
      el('small', { text: juntarNomes(q.membros) }))));

  let trocandoSaindo = false;
  function render() {
    const e = eq();
    const modos = [['EQUIPES', '👥 Equipes'], ['ESCALA', '📋 Conforme escala']];
    const partes = [el('div', { class: 'filtros' }, modos.map(([m, t]) => el('button', { class: 'filtro' + (e.modo === m ? ' ativo' : ''), onclick: () => escolherModo(m) }, t)))];
    const temEquipes = (S.equipes || []).length > 0;
    if (e.modo === 'ESCALA') {
      partes.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Equipe saindo e equipe assumindo: "Conforme escala".' }));
    } else if (e.modo === 'EQUIPES') {
      if (!temEquipes) partes.push(el('div', { class: 'alertas' }, el('div', { text: 'Nenhuma equipe cadastrada ainda. Cadastre uma vez e depois é só tocar.' }),
        ehLider() ? el('div', {}, el('button', { class: 'btn pequeno', onclick: abrirEquipes }, '👥 Cadastrar equipes')) : null));
      const qs = equipe(e.saindoEquipeId), qa = equipe(e.assumindoEquipeId);
      partes.push(el('div', { class: 'bloco-equipe' },
        el('div', { class: 'cartao-topo' }, el('strong', { text: 'EQUIPE SAINDO' }), el('span', { class: 'mudo pequeno', text: qs ? `${qs.nome} · equipe do líder` : 'equipe do líder de plantão' })),
        e.saindoLista.length && !trocandoSaindo ? membros('saindo') : null,
        (!e.saindoLista.length || trocandoSaindo) && temEquipes ? botoesEquipes('saindo') : null,
        temEquipes ? el('div', {}, el('button', { class: 'link', onclick: () => { trocandoSaindo = !trocandoSaindo; render(); } }, trocandoSaindo ? 'Pronto' : 'Trocar equipe')) : null,
        !temEquipes && !e.saindoLista.length ? membros('saindo') : null));
      partes.push(el('div', { class: 'bloco-equipe' },
        el('div', { class: 'cartao-topo' }, el('strong', { text: 'EQUIPE ASSUMINDO' }), el('span', { class: 'mudo pequeno', text: qa ? qa.nome : 'toque na equipe que entra' })),
        temEquipes ? botoesEquipes('assumindo', e.saindoEquipeId) : null,
        e.assumindoLista.length || !temEquipes ? el('div', { style: 'display:grid;gap:6px' },
          el('span', { class: 'mudo pequeno', text: 'Integrantes (toque num nome para substituir por férias):' }), membros('assumindo')) : null));
      partes.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: `No relatório: saindo "${e.saindo || '—'}" · assumindo "${e.assumindo || '—'}"` }));
    } else if (e.modo === 'MANUAL') {
      const inp = el('input', { type: 'text', value: e.saindo || e.assumindo ? `${e.saindo || ''} | ${e.assumindo || ''}` : '', placeholder: 'Gustavo Ramos e Ítalo | Renan Neves e Ewerton' });
      const erroEl = el('p', { class: 'erro pequeno', style: 'margin:0', hidden: true });
      const aplicar = () => {
        const partesP = inp.value.split('|');
        const falha = partesP.length !== 2 ? 'Use o separador "|" uma única vez: Equipe saindo | Equipe assumindo'
          : (!partesP[0].trim() || !partesP[1].trim()) ? 'Preencha os dois lados do "|".' : '';
        if (falha) { erroEl.textContent = falha; erroEl.hidden = false; return; }
        const [sa, as] = partesP.map(x => x.trim());
        Object.assign(e, { saindo: sa, assumindo: as, saindoLista: separarNomes(sa), assumindoLista: separarNomes(as), saindoEquipeId: null, assumindoEquipeId: null });
        agendarSalvar(); aviso('Equipes aplicadas ✓'); render();
      };
      partes.push(el('label', { class: 'campo' }, 'Equipe saindo | Equipe assumindo (separador "|" obrigatório)', inp), erroEl,
        el('div', { class: 'linha' }, el('button', { class: 'btn primario pequeno', onclick: aplicar }, 'Aplicar')));
    }
    partes.push(el('div', { class: 'rodape-equipes' },
      e.modo !== 'MANUAL' ? el('button', { class: 'link', onclick: () => escolherModo('MANUAL') }, '✍️ Digitar com |') : el('button', { class: 'link', onclick: () => escolherModo('EQUIPES') }, '👥 Voltar às equipes'),
      ehLider() ? el('button', { class: 'link', onclick: abrirEquipes }, '⚙️ Cadastro de equipes') : null));
    box.replaceChildren(...partes);
  }
  render();
  return box;
}

// ----------------------------- Cadastro de equipes ----------------------
async function abrirEquipes() {
  fecharModal();
  await Promise.all([carregarEquipes(), carregarNomesEquipe()]);
  const lista = el('div', { style: 'display:grid;gap:10px' });
  const desenhar = () => lista.replaceChildren(
    ...(S.equipes || []).map(q => el('div', { class: 'usuario-card' },
      el('div', { class: 'cartao-topo' },
        el('strong', {}, el('span', { class: 'ponto-cor', style: `background:${CORES_EQUIPE[q.cor] || CORES_EQUIPE.azul}` }), q.nome),
        el('button', { class: 'btn pequeno', onclick: () => formEquipe(q) }, 'Editar')),
      el('div', { class: 'mudo pequeno', text: juntarNomes(q.membros) }),
      (q.lideres || []).length ? el('div', { class: 'mudo pequeno', text: `Líder(es): ${(q.lideres || []).map(id => S.lideresDisponiveis?.find(l => l.id === id)?.nome || '?').join(', ')}` }) : null)),
    (S.equipes || []).length ? null : el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '👥' }), 'Nenhuma equipe cadastrada.'));
  const formEquipe = (q = {}) => {
    const sel = new Set(q.membros || []);
    const lideres = new Set(q.lideres || []);
    const [cNome, iNome] = campoLinha('Nome da equipe', q.nome || '', { placeholder: 'Ex.: Equipe Azul', autofocus: !q.id });
    const cor = el('select', {}, Object.keys(CORES_EQUIPE).map(k => el('option', { value: k, text: k.charAt(0).toUpperCase() + k.slice(1) })));
    cor.value = q.cor || 'azul';
    const chips = el('div', { class: 'chips' });
    const desenharChips = () => chips.replaceChildren(
      ...[...new Set([...(S.nomesEquipe || []), ...sel])].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(n => el('button', { class: `chip${sel.has(n) ? ' ativo' : ''}`, onclick: () => { sel.has(n) ? sel.delete(n) : sel.add(n); desenharChips(); } }, sel.has(n) ? `✓ ${n}` : n)),
      el('button', { class: 'chip novo', onclick: () => {
        const nome = prompt('Nome completo do integrante:');
        if (nome && nome.trim()) { sel.add(nomeProprio(nome)); desenharChips(); }
      } }, '+ Nome novo'));
    desenharChips();
    const lid = el('div', { class: 'chips' }, (S.lideresDisponiveis || []).map(l => {
      const b = el('button', { class: `chip${lideres.has(l.id) ? ' ativo' : ''}`, onclick: () => { lideres.has(l.id) ? lideres.delete(l.id) : lideres.add(l.id); b.className = `chip${lideres.has(l.id) ? ' ativo' : ''}`; } }, l.nome);
      return b;
    }));
    abrirModal(q.id ? `Editar ${q.nome}` : 'Nova equipe', [
      el('div', { class: 'grade-2' }, cNome, el('label', { class: 'campo' }, 'Cor', cor)),
      el('div', { class: 'campo' }, 'Integrantes (toque para marcar)', chips),
      el('div', { class: 'campo' }, 'Líder(es) desta equipe — ao assumir o plantão, ela vira a equipe saindo', lid)
    ], [
      q.id ? el('button', { class: 'btn fantasma', style: 'color:var(--vermelho)', onclick: async () => {
        if (!await confirmar('Excluir equipe?', `"${q.nome}" sai do cadastro. Relatórios já feitos não mudam.`, 'Excluir', true)) return formEquipe(q);
        try { await api('POST', `/api/equipes/${q.id}/excluir`); await carregarEquipes(); aviso('Equipe excluída'); desenhar(); } catch (e) { aviso(e.message, true); }
      } }, 'Excluir') : null,
      ...botoesSalvar(async () => {
        await api('POST', '/api/equipes', { id: q.id, nome: iNome.value, cor: cor.value, membros: [...sel], lideres: [...lideres] });
        fecharModal(); await Promise.all([carregarEquipes(), carregarNomesEquipe()]); aviso('Equipe salva ✓'); desenhar();
      })
    ]);
  };
  desenhar();
  abrirPainel('Equipes', [
    el('p', { class: 'mudo', text: 'Cadastre cada equipe uma vez. No relatório, a equipe do líder sai automaticamente e a equipe que entra é escolhida com um toque.' }),
    ehLider() ? el('div', {}, el('button', { class: 'btn primario', onclick: () => formEquipe() }, '+ Nova equipe')) : null,
    lista
  ]);
}

function atualizarPreviaViva() {
  const alvo = $('#previa-viva-texto');
  if (!alvo) return;
  clearTimeout(S.timerPrevia);
  S.timerPrevia = setTimeout(async () => {
    try { const t = await api('GET', '/api/ficha/texto'); const a = $('#previa-viva-texto'); if (a) a.replaceChildren(textoWhats(t.whatsapp)); } catch (_) {}
  }, 500);
}

function painelPreviaViva() {
  return el('aside', { class: 'cartao previa-viva' },
    el('div', { class: 'cartao-topo' }, el('h2', { text: 'Prévia ao vivo' }), el('span', { class: 'mudo pequeno', text: 'como sai no WhatsApp' })),
    el('div', { id: 'previa-viva-texto', class: 'previa' }, el('span', { class: 'mudo', text: 'Carregando…' })));
}

function desenharRelatorio() {
  const c = $('#aba-relatorio');
  if (!S.ficha) return;
  const turno = el('select', { onchange: e => { S.ficha.turno = e.target.value; agendarSalvar(); } },
    el('option', { value: 'DIURNO', text: 'DIURNO' }), el('option', { value: 'NOTURNO', text: 'NOTURNO' }));
  turno.value = S.ficha.turno;

  const blocos = [
    el('section', { class: 'cartao' },
      el('div', { id: 'progresso-rel', class: 'progresso' }, el('strong', { text: '' }), el('div', { class: 'barra' }, el('span'))),
      el('div', { class: 'grade-2' }, el('label', { class: 'campo' }, 'Turno', turno), campo('Data', 'data', { placeholder: 'DD/MM/AAAA' })),
      el('div', { id: 'bloco-conferencia', class: 'alertas' })),
    secao('1', 'Efetivo CCOS', campo('', 'efetivo', { multilinha: true, placeholder: '✓ S/A' })),
    secao('2', 'Viatura – VTR',
      el('div', { class: 'grade-2' }, campo('Veículo', 'vtr.modelo'), campo('Placa', 'vtr.placa')),
      el('div', { class: 'grade-2' }, campo('KM inicial', 'vtr.kmInicial', { tipo: 'number' }), campo('KM final', 'vtr.kmFinal', { tipo: 'number' })),
      el('div', { id: 'km-rodados', class: 'mudo pequeno' })),
    secao('3', 'Sistemas',
      campo('CFTV', 'sistemas.cftv', { multilinha: true, placeholder: '✓ S/A' }),
      campo('CA – Controle de acesso', 'sistemas.ca', { multilinha: true, linhas: 1, placeholder: '✓ S/A' }),
      el('div', { class: 'grade-2' }, campo('OCR – Assertividade', 'sistemas.ocrAssertividade', { placeholder: '88,05%' }), campo('OCR – Total de leituras', 'sistemas.ocrLeituras', { tipo: 'number', placeholder: '188' }))),
    secao('4', 'Atividades realizadas', editorLista('atividades', { vazio: 'Nenhuma atividade.', placeholder: '19:01h Descreva a atividade', rotuloNovo: 'Nova atividade' })),
    secao('5', 'Avisos e ações de acompanhamento', listaAvisosRelatorio()),
    secao('6', 'Movimentação de navios',
      el('div', { class: 'terminal-tit', text: 'T-ORE' }), editorNavios('tore'),
      el('div', { class: 'terminal-tit', text: 'T-OIL' }), editorNavios('toil')),
    secao('7', 'Ocorrências', editorLista('ocorrencias', { vazio: 'Sem ocorrências (sai "✓ S/A").', placeholder: '19:01h Descreva a ocorrência', rotuloNovo: 'Nova ocorrência' })),
    secao('8', 'Passagem de turno', editorEquipes()),
    secao('', '✉️ Operações de bordo',
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Um e-mail por navio. Saem automaticamente para o líder de plantão quando há horário de saída.' }),
      listaOperacoes(),
      el('div', {}, el('button', { class: 'btn pequeno', onclick: () => abrirFormOperacao({ horaInicial: agoraBR().hora }) }, '+ Nova operação'))),
    el('div', { class: 'barra-acoes' },
      el('span', { id: 'estado-salvo', class: 'estado-salvo', text: S.sujo ? 'Salvando…' : 'Salvo ✓' }),
      el('button', { class: 'btn', onclick: abrirPrevia }, '👁 Prévia'),
      el('button', { class: 'btn', onclick: exportarPdf }, '📄 PDF'),
      el('button', { class: 'btn', onclick: async () => { await salvarAgora(); baixarArquivo('/api/ficha/xlsx', 'Relatorio.xlsx'); } }, '📊 Excel'),
      ehLider() ? el('button', { class: 'btn primario', onclick: publicar }, '🚀 Publicar') : null)
  ];
  if (ehDesktop()) c.replaceChildren(el('div', { class: 'rel-desktop' }, el('div', { class: 'aba' }, ...blocos), painelPreviaViva()));
  else c.replaceChildren(...blocos);
  atualizarProgresso();
  atualizarPreviaViva();
  desenharConferencia();
  atualizarKmRodados();
  requestAnimationFrame(() => c.querySelectorAll('textarea').forEach(autoAltura));
}

// --------------------------- Prévia e publicação ---------------------
async function abrirPrevia() {
  try {
    await salvarAgora();
    const t = await api('GET', '/api/ficha/texto');
    const f = S.ficha;
    const nome = `Relatorio_Turno_${f.turno}_${f.data.replace(/\//g, '-')}.txt`;
    abrirModal('Prévia do relatório', [
      t.conferencia.length ? el('div', { class: 'alertas' }, t.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
      el('div', { class: 'previa' }, textoWhats(t.whatsapp))
    ], [
      el('button', { class: 'btn', onclick: () => copiar(t.whatsapp) }, '📋 Copiar'),
      el('button', { class: 'btn', onclick: () => baixar(nome, t.simples) }, '💾 .txt'),
      el('button', { class: 'btn', onclick: () => imprimir(`CCOS — Relatório do Turno ${f.turno} · ${f.data}`, t.simples, f.equipes) }, '📄 PDF'),
      el('button', { class: 'btn', onclick: () => baixarArquivo('/api/ficha/xlsx', 'Relatorio.xlsx') }, '📊 Excel'),
      ehLider() ? el('button', { class: 'btn primario', onclick: () => { fecharModal(); publicar(); } }, '🚀 Publicar') : null
    ]);
  } catch (e) { aviso(e.message, true); }
}

function imprimir(titulo, textoSimples, equipes) {
  $('#impressao').replaceChildren(
    el('div', { class: 'cab' }, el('strong', { text: 'FERROPORT · PORTO DO AÇU' }), el('br'), el('span', { text: `${titulo} · emitido em ${agoraBR().data} ${agoraBR().hora}` })),
    el('pre', { text: textoSimples }),
    equipes ? el('div', { class: 'assinaturas' }, el('div', { text: `Equipe saindo: ${equipes.saindo || ''}` }), el('div', { text: `Equipe assumindo: ${equipes.assumindo || ''}` })) : null);
  window.print();
}

async function publicarGenerico({ titulo, urlTexto, urlPublicar, textoOk }) {
  const t = await api('GET', urlTexto);
  const conectado = S.estado?.whatsapp?.meu?.estado === 'CONECTADO';
  const nomeGrupo = S.config?.nomesGrupos?.[S.config?.grupoPublicacao] || '';
  const problema = !deplantao() ? 'Para publicar, assuma o plantão na Central.' : !conectado ? 'Seu WhatsApp não está conectado (Menu › Meu perfil).' : !S.config?.grupoPublicacao ? 'O administrador ainda não escolheu o grupo de publicação.' : '';
  if (problema) {
    return abrirModal('Não dá para publicar agora', [el('p', { text: problema }), el('p', { class: 'mudo', text: 'Você pode copiar o texto e colar no grupo.' })], [
      el('button', { class: 'btn primario', onclick: () => { copiar(t.whatsapp); fecharModal(); } }, '📋 Copiar texto')]);
  }
  const anexo = el('input', { type: 'checkbox' });
  const ok = await confirmar(titulo, [
    el('p', {}, 'Será enviado pelo seu WhatsApp para ', el('strong', { text: nomeGrupo || 'o grupo escolhido' }), ' exatamente como na prévia.'),
    t.conferencia?.length ? el('div', { class: 'alertas' }, el('strong', { text: 'Antes de publicar, confira:' }), t.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
    el('label', { class: 'check' }, anexo, 'Anexar também o arquivo .txt')
  ], 'Publicar agora');
  if (!ok) return;
  await api('POST', urlPublicar, { anexarTxt: anexo.checked });
  aviso(textoOk);
}

async function exportarPdf() {
  try {
    await salvarAgora();
    const t = await api('GET', '/api/ficha/texto');
    imprimir(`CCOS — Relatório do Turno ${S.ficha.turno} · ${S.ficha.data}`, t.simples, S.ficha.equipes);
  } catch (e) { aviso(e.message, true); }
}

// Fechar o turno: confirmação, lembrete das operações sem saída e próximo turno preparado
async function publicar() {
  try {
    await salvarAgora();
    await carregarCentral();
    const t = await api('GET', '/api/ficha/texto');
    const f = S.ficha;
    const conectado = S.estado?.whatsapp?.meu?.estado === 'CONECTADO';
    const nomeGrupo = S.config?.nomesGrupos?.[S.config?.grupoPublicacao] || '';
    const problema = !deplantao() ? 'Para publicar, assuma o plantão (aba Plantão › Turno).' : !conectado ? 'Seu WhatsApp não está conectado (Menu › Meu perfil).' : !S.config?.grupoPublicacao ? 'O administrador ainda não escolheu o grupo de publicação.' : '';
    if (problema) {
      return abrirModal('Não dá para publicar agora', [el('p', { text: problema }), el('p', { class: 'mudo', text: 'Você pode copiar o texto e colar no grupo.' })], [
        el('button', { class: 'btn primario', onclick: () => { copiar(t.whatsapp); fecharModal(); } }, '📋 Copiar texto')]);
    }
    const abertas = S.central.operacoes.filter(o => !o.horaFinal);
    const passar = new Set(abertas.map(o => o.id));
    const linhaOp = o => {
      const chk = el('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked ? passar.add(o.id) : passar.delete(o.id); } });
      return el('div', { class: 'op-aberta' },
        el('div', {}, el('strong', { text: `${o.rotuloTipo} – ${o.navio || 'navio?'}` }),
          el('div', { class: 'mudo pequeno', text: `${o.terminal || ''}${o.placa ? ' · placa ' + o.placa : ''} · entrada ${o.horaInicial || '?'}` })),
        el('div', { class: 'linha' },
          el('button', { class: 'btn verde pequeno', onclick: () => { fecharModal(); registrarSaida(o, null, publicar); } }, '🏁 Registrar saída agora'),
          el('label', { class: 'check', style: 'margin:0' }, chk, 'Passar para o próximo turno')));
    };
    const prox = f.turno === 'DIURNO' ? `NOTURNO ${f.data}` : `DIURNO do dia seguinte`;
    const anexo = el('input', { type: 'checkbox' });
    abrirModal('🚀 Fechar o turno e publicar', [
      el('div', { class: 'citacao' },
        el('div', {}, el('strong', { text: `RELATÓRIO DO TURNO – ${f.turno} · ${f.data}` })),
        el('div', { class: 'mudo pequeno', text: `Destino: ${nomeGrupo || 'grupo de publicação'} · pelo seu WhatsApp` }),
        el('div', { class: 'mudo pequeno', text: `Equipe saindo: ${f.equipes?.saindo || 'Conforme escala'} · Equipe assumindo: ${f.equipes?.assumindo || 'Conforme escala'}` })),
      t.conferencia?.length ? el('div', { class: 'alertas' }, el('strong', { text: 'Confira antes de publicar:' }), t.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
      abertas.length ? el('div', { style: 'display:grid;gap:8px' },
        el('div', { class: 'alerta-saida' }, el('span', { text: `⚠ ${abertas.length} operação${abertas.length > 1 ? 'ões' : ''} sem saída registrada` })),
        ...abertas.map(linhaOp),
        el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Marcadas: continuam abertas no próximo turno. Desmarcadas: ficam só neste relatório.' })) : null,
      el('label', { class: 'check' }, anexo, 'Anexar também o arquivo .txt'),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: `Depois de publicar, o robô guarda o relatório no histórico e já prepara o próximo turno (${prox}).` })
    ], [
      el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'),
      el('button', { class: 'btn primario', onclick: async ev => {
        ev.target.disabled = true;
        try {
          const r = await api('POST', '/api/ficha/publicar', { anexarTxt: anexo.checked, passarOps: [...passar] });
          fecharModal();
          aviso(`Relatório publicado ✓ · próximo turno ${r.proximo?.turno || ''} ${r.proximo?.data || ''} preparado`);
          S.historico = null;
          await recarregarTudo();
          trocarAba('central');
        } catch (e) { ev.target.disabled = false; aviso(e.message, true); }
      } }, '✓ Confirmar publicação')
    ]);
  } catch (e) { aviso(e.message, true); }
}

// =====================================================================
// ABA HISTÓRICO · todos os relatórios (mais recente no topo)
// =====================================================================
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ORIGENS = { publicado: 'publicado por nós', grupo: 'do grupo', importado: 'importado', colado: 'colado' };

async function carregarHistorico() { S.historico = (await api('GET', '/api/relatorios-hist')).relatorios; }

function desenharHistorico() {
  const c = $('#aba-historico');
  if (!S.historico) {
    c.replaceChildren(el('div', { class: 'vazio' }, 'Carregando…'));
    carregarHistorico().then(desenharHistorico).catch(e => aviso(e.message, true));
    return;
  }
  const termo = semAcento(S.buscaHist || '').toLowerCase().trim();
  const itens = S.historico.filter(h => !termo || semAcento(`${h.data} ${h.turno} ${h.autor} ${ORIGENS[h.origem] || ''}`).toLowerCase().includes(termo));
  const busca = el('input', { type: 'search', placeholder: 'Buscar por data (14/11), turno ou autor…', value: S.buscaHist || '' });
  busca.addEventListener('input', () => { S.buscaHist = busca.value; clearTimeout(S.timerBusca); S.timerBusca = setTimeout(() => { desenharHistorico(); const b = $('#aba-historico input[type=search]'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 250); });

  const grupos = new Map();
  for (const h of itens) {
    const [, m, a] = (h.data || '').split('/');
    const chave = m && a ? `${MESES[Number(m) - 1]} ${a}` : 'Sem data';
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(h);
  }
  const partes = [
    el('section', { class: 'cartao' },
      el('div', { class: 'cartao-topo' }, el('h2', { text: `Histórico de relatórios (${S.historico.length})` }),
        ehLider() ? el('button', { class: 'btn pequeno', onclick: importarConversa }, '📥 Importar do WhatsApp') : null),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Todos os relatórios capturados no grupo, publicados por nós ou importados. Mais recentes no topo.' }),
      busca),
    itens.length ? el('div', { style: 'display:grid;gap:8px' }, [...grupos.entries()].map(([mes, lista]) => [
      el('h3', { class: 'mes-tit', text: `${mes} · ${lista.length}` }),
      ...lista.map(h => el('button', { class: `linha-op${S.histSel === h.id ? ' selecionado' : ''}`, 'data-id': h.id, onclick: () => abrirRelatorioHist(h) },
        el('span', { class: 'ic', text: h.turno === 'NOTURNO' ? '🌙' : '☀️' }),
        el('span', { style: 'min-width:0' }, el('div', { class: 'tit', text: `${h.turno || '?'} · ${h.data || 'sem data'}` }),
          el('div', { class: 'sub', text: `${h.autor || 'autor desconhecido'}${h.grupoNome ? ' · ' + h.grupoNome : ''}` })),
        el('span', { class: 'etiqueta-origem', text: ORIGENS[h.origem] || h.origem })))
    ]).flat()) : el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '🗂️' }), termo ? 'Nada encontrado.' : 'Nenhum relatório ainda. Importe a conversa do grupo para trazer os meses anteriores.')
  ];
  if (ehDesktop()) {
    const lado = el('aside', { id: 'hist-detalhe', class: 'cartao hist-detalhe' }, el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '📑' }), 'Escolha um relatório na lista para ver aqui.'));
    c.replaceChildren(el('div', { class: 'hist-desktop' }, el('div', { class: 'aba' }, ...partes), lado));
    const sel = itens.find(h => h.id === S.histSel) || itens[0];
    if (sel) abrirRelatorioHist(sel);
  } else c.replaceChildren(...partes);
}

async function abrirRelatorioHist(h) {
  try {
    const { relatorio: r } = await api('GET', `/api/relatorios-hist/${encodeURIComponent(h.id)}`);
    const simples = r.texto.replace(/\*/g, '');
    const corpo = [
      el('div', { class: 'mudo pequeno', text: `${r.autor || 'autor desconhecido'} · ${ORIGENS[r.origem] || r.origem}` }),
      el('div', { class: 'previa' }, textoWhats(r.texto))
    ];
    const botoes = [
      el('button', { class: 'btn', onclick: () => copiar(r.texto) }, '📋 Copiar'),
      el('button', { class: 'btn', onclick: () => imprimir(`CCOS — Relatório do Turno ${r.turno} · ${r.data}`, simples, null) }, '📄 PDF'),
      el('button', { class: 'btn', onclick: () => baixarArquivo(`/api/relatorios-hist/${encodeURIComponent(r.id)}/xlsx`, 'Relatorio.xlsx') }, '📊 Excel'),
      ehLider() ? el('button', { class: 'btn primario', onclick: async () => {
        if (!await confirmar('Começar o turno a partir deste relatório?', `O turno atual vai para os rascunhos arquivados e o novo herda KM, navios, avisos e equipes de ${r.turno} ${r.data}.`, 'Herdar')) return;
        try { await api('POST', `/api/relatorios-hist/${encodeURIComponent(r.id)}/herdar`); aviso('Turno preparado ✓'); await recarregarTudo(); trocarAba('central'); } catch (e) { aviso(e.message, true); }
      } }, '⤵ Herdar este') : null
    ];
    const lado = $('#hist-detalhe');
    if (ehDesktop() && lado) {
      S.histSel = r.id;
      document.querySelectorAll('#aba-historico .linha-op').forEach(b => b.classList.toggle('selecionado', b.dataset.id === r.id));
      lado.replaceChildren(el('div', { class: 'cartao-topo' }, el('h2', { text: `${r.turno} · ${r.data}` })), el('div', { class: 'linha' }, botoes), ...corpo);
      return;
    }
    abrirModal(`${r.turno} · ${r.data}`, corpo, botoes);
  } catch (e) { aviso(e.message, true); }
}

// Lê o arquivo de "Exportar conversa" do WhatsApp (Android e iPhone) e envia só os relatórios
function mensagensDaConversa(texto) {
  const cab = /^\u200e?\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*(?:-\s*)?([^:]{1,80}?):\s?(.*)$/;
  const msgs = [];
  let atual = null;
  for (const linha of texto.replace(/\r/g, '').split('\n')) {
    const m = linha.replace(/^[\u200e\u200f]/, '').match(cab);
    if (m) {
      const ano = m[3].length === 2 ? '20' + m[3] : m[3];
      atual = { autor: m[6].trim(), texto: m[7], ts: Date.UTC(+ano, +m[2] - 1, +m[1], +m[4] + 3, +m[5]) };
      msgs.push(atual);
    } else if (atual) atual.texto += '\n' + linha;
  }
  return msgs.filter(x => /RELAT[OÓ]RIO\s+(D[OE]\s+)?TURNO/i.test(x.texto));
}

function importarConversa() {
  const inp = el('input', { type: 'file', accept: '.txt,text/plain' });
  const info = el('p', { class: 'mudo pequeno', style: 'margin:0' });
  abrirModal('📥 Importar relatórios do WhatsApp', [
    el('ol', { class: 'pequeno', style: 'margin:0;padding-left:18px;display:grid;gap:4px' },
      el('li', { text: 'No WhatsApp, abra o grupo (ex.: Equipe Seg. Ferroport).' }),
      el('li', { text: 'Toque em ⋮ › Mais › Exportar conversa › Sem mídia.' }),
      el('li', { text: 'Salve o arquivo .txt e escolha-o abaixo (no iPhone, abra o .zip e use o _chat.txt).' })),
    inp, info
  ], botoesSalvar(async () => {
    const arq = inp.files?.[0];
    if (!arq) throw new Error('Escolha o arquivo .txt da conversa.');
    const msgs = mensagensDaConversa(await arq.text());
    if (!msgs.length) throw new Error('Nenhum "RELATÓRIO DO TURNO" encontrado nesse arquivo.');
    let novos = 0, repetidos = 0, atualizados = 0, ignorados = 0, de = '', ate = '';
    for (let i = 0; i < msgs.length; i += 80) {
      info.textContent = `Importando ${Math.min(i + 80, msgs.length)} de ${msgs.length}…`;
      const r = await api('POST', '/api/relatorios-hist/importar', { mensagens: msgs.slice(i, i + 80) });
      novos += r.novos; repetidos += r.repetidos; atualizados += r.atualizados || 0; ignorados += r.ignorados || 0;
      if (r.de && (!de || r.de < de)) de = r.de;
      if (r.ate && r.ate > ate) ate = r.ate;
    }
    const dataDe = k => k ? k.slice(0, 10).split('-').reverse().join('/') : '?';
    fecharModal();
    abrirModal('Importação concluída', [
      el('div', { class: 'contadores' },
        el('div', { class: 'contador' }, el('strong', { text: String(msgs.length) }), el('span', { text: 'relatórios no arquivo' })),
        el('div', { class: 'contador' }, el('strong', { text: String(novos) }), el('span', { text: 'novos' })),
        el('div', { class: 'contador' }, el('strong', { text: String(repetidos + atualizados) }), el('span', { text: 'já existiam' }))),
      de ? el('p', { style: 'margin:0', text: `Período encontrado: ${dataDe(de)} a ${dataDe(ate)}.` }) : null,
      ignorados ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: `${ignorados} mensagem(ns) mencionavam o relatório mas não estavam no formato completo.` }) : null,
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Cada turno aparece uma vez só. Se faltarem meses, o celular que exportou pode não ter o histórico antigo do grupo: exporte de um aparelho que tenha.' })
    ], [el('button', { class: 'btn primario', 'data-fechar': true }, 'Ok')]);
    S.historico = null;
    if (S.aba === 'historico') desenharHistorico();
  }, 'Importar'));
}

// =====================================================================
// ABA PAINEL (visão gerencial — próxima fase)
// =====================================================================
function desenharPainelGerencial() {
  const c = $('#aba-painel');
  const C = S.central;
  const ops = C?.operacoes || [];
  const abertas = (C?.pendencias || []).filter(p => p.status === 'ABERTA');
  const card = (n, t) => el('div', { class: 'contador' }, el('strong', { text: String(n) }), el('span', { text: t }));
  c.replaceChildren(
    el('section', { class: 'cartao' },
      el('h2', { text: '📊 Painel gerencial' }),
      el('p', { class: 'mudo', style: 'margin:0', text: 'Em construção. Aqui vão ficar os indicadores do CCOS: operações de bordo, e-mails, pendências, Digital, ocorrências, OCR e KM, com filtros por período e equipe.' })),
    el('section', { class: 'cartao' },
      el('h3', { text: 'Turno atual' }),
      el('div', { class: 'contadores' },
        card(ops.length, 'Operações de bordo'), card(ops.filter(o => !o.horaFinal).length, 'Sem saída'),
        card(abertas.length, 'Pendências abertas'), card(S.historico?.length ?? '—', 'Relatórios no histórico'))));
  if (!S.historico) carregarHistorico().then(() => { if (S.aba === 'painel') desenharPainelGerencial(); }).catch(() => {});
}

// =====================================================================
// PAINÉIS: menu, escala, perfil, usuários, configurações, histórico
// =====================================================================
function abrirPainel(titulo, conteudo, aoFechar) {
  const p = $('#painel');
  p.replaceChildren(el('div', { class: 'painel-conteudo' },
    el('div', { class: 'painel-topo' }, el('button', { class: 'btn-icone', 'aria-label': 'Voltar', onclick: () => fecharPainel(aoFechar) }, '←'), el('h1', { text: titulo })),
    ...[].concat(conteudo).filter(Boolean)));
  p.hidden = false;
  p.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function fecharPainel(aoFechar) {
  $('#painel').hidden = true;
  document.body.style.overflow = '';
  clearInterval(S.painelTimer);
  if (aoFechar) aoFechar();
  recarregarTudo();
}

function abrirMenu() {
  const u = S.usuario;
  const item = (ic, txt, fn) => el('button', { onclick: () => { fecharModal(); fn(); } }, el('span', { text: ic }), txt);
  abrirModal(u.nome, [
    el('p', { class: 'mudo pequeno', style: 'margin:0', text: `${u.email} · ${u.rotuloPerfil} · versão ${S.meta?.versao || '?'}` }),
    el('div', { class: 'menu-lista' },
      item('👤', 'Meu perfil e WhatsApp', abrirPerfil),
      item('📦', 'Passagem da escala', abrirEscala),
      item('🗃️', 'Rascunhos de turnos arquivados', abrirHistorico),
      item('✨', `Fundo animado: ${Fundo.ativo() ? 'ligado' : 'desligado'}`, () => { Fundo.ligar(!Fundo.ativo()); aviso(Fundo.ativo() ? 'Fundo animado ligado' : 'Fundo animado desligado (economiza bateria)'); }),
      ehLider() ? item('🧑‍🤝‍🧑', 'Equipes', abrirEquipes) : null,
      ehAdmin() ? item('👥', 'Usuários', abrirUsuarios) : null,
      ehAdmin() ? item('⚙️', 'Configurações', abrirConfig) : null,
      item('🚪', 'Sair', async () => { await api('POST', '/api/logout'); mostrarLogin(); }))
  ]);
}

// ----------------------------- Resumo do plantão ---------------------
async function abrirResumo() {
  try { await Promise.all([carregarCentral(), carregarFicha(), carregarEntrada()]); } catch (e) { return aviso(e.message, true); }
  const C = S.central, F = S.ficha, E = S.estado;
  const abertas = C.pendencias.filter(p => p.status === 'ABERTA');
  const avisos = abertas.filter(p => p.tipo === 'AVISO');
  const digital = abertas.filter(p => p.tipo === 'DIGITAL');
  const opsAndamento = C.operacoes.filter(o => !o.horaFinal);
  const emails = emailsPendentes();
  const urgentes = S.entrada.filter(i => i.status === 'pendente' && i.urgente);
  const naEntrada = S.entrada.filter(i => i.status === 'pendente' && !i.urgente).length;
  const ultimaAtualizacao = p => (p.historico || []).filter(h => h.tipo === 'ATUALIZACAO').slice(-1)[0];
  const linhasNavio = lista => (lista || []).filter(n => n.navio || (n.linhas || []).some(Boolean));

  const linhaItem = (ic, tit, sub, abrir, extra) => el('button', { class: `pend${extra || ''}`, onclick: () => { fecharPainel(); abrir(); } },
    el('span', { class: 'ic', text: ic }), el('span', { style: 'min-width:0;white-space:normal' }, el('div', { class: 'tit', style: 'white-space:normal', text: tit }), sub ? el('div', { class: 'sub', style: 'white-space:pre-line', text: sub }) : null), el('span', { class: 'seta', text: '›' }));
  const bloco = (titulo, qtd, itens, vazio) => el('section', { class: 'cartao' },
    el('h2', {}, titulo, qtd !== null ? el('span', { class: `etiqueta ${qtd ? 'atencao' : 'ok'}`, style: 'margin-left:8px', text: String(qtd) }) : null),
    itens.length ? el('div', { class: 'lista-pend' }, itens) : el('p', { class: 'mudo pequeno', style: 'margin:0', text: vazio }));

  // texto para copiar / imprimir
  const t = [];
  t.push(`RESUMO DO PLANTÃO — ${F.turno} ${F.data}`, `Líder: ${E.plantao.liderNome || 'ninguém assumiu'}`, '');
  if (urgentes.length) { t.push('🚨 URGENTE'); urgentes.forEach(i => t.push(`• ${i.hora} ${i.autor}: ${i.texto.replace(/\n+/g, ' ')}`)); t.push(''); }
  t.push(`📌 AVISOS EM ABERTO (${avisos.length})`); avisos.forEach(p => { const u = ultimaAtualizacao(p); t.push(`• ${p.titulo}${p.texto ? ': ' + p.texto.replace(/\n+/g, ' ') : ''}${u ? ` (Atualização ${u.data} ${u.hora}h: ${u.texto})` : ''}`); }); if (!avisos.length) t.push('• S/A'); t.push('');
  t.push(`🛠️ PENDÊNCIAS DA DIGITAL (${digital.length})`); digital.forEach(p => t.push(`• ${p.titulo}${p.texto ? ': ' + p.texto.replace(/\n+/g, ' ') : ''}`)); if (!digital.length) t.push('• S/A'); t.push('');
  t.push(`🚢 OPERAÇÕES EM ANDAMENTO (${opsAndamento.length})`); opsAndamento.forEach(o => t.push(`• ${o.rotuloTipo} · ${o.navio || '?'} · desde ${o.horaInicial || '?'}${o.placa ? ' · ' + o.placa : ''}`)); if (!opsAndamento.length) t.push('• S/A'); t.push('');
  t.push(`✉️ E-MAILS A ENCAMINHAR (${emails.length})`); emails.forEach(o => t.push(`• ${o.rotuloTipo} · ${o.navio || ''}`)); if (!emails.length) t.push('• S/A'); t.push('');
  t.push('🏁 SITUAÇÃO DO TERMINAL');
  t.push(`• VTR ${F.vtr?.modelo || ''} ${F.vtr?.placa || ''}: KM ${F.vtr?.kmInicial ?? '—'}`);
  t.push(`• CFTV: ${(F.sistemas?.cftv || 'S/A').replace(/\n+/g, ' ')}`);
  t.push(`• Controle de acesso: ${(F.sistemas?.ca || 'S/A').replace(/\n+/g, ' ')}`);
  t.push(`• OCR: ${F.sistemas?.ocrAssertividade || '—'} · ${F.sistemas?.ocrLeituras || '—'} leituras`);
  for (const [nome, chave] of [['T-ORE', 'tore'], ['T-OIL', 'toil']]) {
    const ns = linhasNavio(F.navios?.[chave]);
    t.push(`• ${nome}: ${ns.length ? ns.map(n => `${n.navio}${(n.linhas || []).filter(Boolean).length ? ' (' + n.linhas.filter(Boolean).map(l => l.replace(/[.;]\s*$/, '')).join(' · ') + ')' : ''}`).join(' | ') : 'S/A'}`);
  }
  const textoResumo = t.join('\n');

  const navioCartao = (nome, chave) => {
    const ns = linhasNavio(F.navios?.[chave]);
    return el('div', {}, el('div', { class: 'terminal-tit', text: nome }),
      ns.length ? ns.map(n => el('div', { class: 'pequeno', style: 'margin:4px 0' }, el('strong', { text: n.navio || '(sem nome)' }), (n.linhas || []).filter(Boolean).length ? ` — ${n.linhas.filter(Boolean).map(l => l.replace(/[.;]\s*$/, '')).join(' · ')}` : ''))
        : el('div', { class: 'mudo pequeno', text: 'S/A' }));
  };
  const info = (k, v) => el('div', {}, el('div', { class: 'mudo pequeno', text: k }), el('div', { style: 'white-space:pre-wrap', text: v || '—' }));
  const h = F.herdadoDe;

  abrirPainel('📋 Resumo do plantão', [
    el('section', { class: 'faixa' },
      el('h2', { text: `${F.turno} · ${F.data}` }),
      el('div', { class: 'mudo pequeno', text: `Líder de plantão: ${E.plantao.liderNome || 'ninguém assumiu ainda'}${h ? ` · herdado de ${h.autor || 'equipe anterior'} (${h.turno || ''} ${h.data || ''})` : ''}` }),
      el('div', { class: 'contadores' },
        contador(urgentes.length, 'Urgentes', () => {}, urgentes.length > 0),
        contador(avisos.length + digital.length, 'Pendências', () => {}),
        contador(opsAndamento.length + emails.length, 'Operações/e-mails', () => {})),
      el('div', { class: 'linha' },
        el('button', { class: 'btn pequeno', onclick: () => copiar(textoResumo) }, '📋 Copiar resumo'),
        el('button', { class: 'btn pequeno', onclick: () => imprimir(`CCOS — Resumo do plantão ${F.turno} · ${F.data}`, textoResumo) }, '📄 Imprimir / PDF'))),
    urgentes.length ? bloco('🚨 Urgente', urgentes.length, urgentes.map(i => linhaItem('🚨', `${i.hora} · ${i.autor}`, i.texto, () => { S.filtroEntrada = 'pendente'; trocarAba('entrada'); }, ' erro')), '') : null,
    bloco('📌 Avisos em aberto', avisos.length, avisos.map(p => { const u = ultimaAtualizacao(p); return linhaItem('📌', p.titulo, `${p.texto || ''}${u ? `\nÚltima atualização (${u.data} ${u.hora}h, ${u.por}): ${u.texto}` : ''}\nAberto há ${p.turnosAberto} turno(s)`, () => abrirPendencia(p)); }), 'Nenhum aviso em aberto.'),
    bloco('🛠️ Pendências da Digital', digital.length, digital.map(p => linhaItem('🛠️', p.titulo, `${p.texto || ''}\nAberta há ${p.turnosAberto} turno(s)`, () => abrirPendencia(p))), 'Nenhuma pendência da Digital.'),
    bloco('🚢 Operações em andamento', opsAndamento.length, opsAndamento.map(o => linhaItem('🚢', `${o.rotuloTipo} · ${o.navio || '?'}`, `Desde ${o.horaInicial || '?'}${o.placa ? ' · placa ' + o.placa : ''}${o.empresa ? ' · ' + o.empresa : ''}`, () => abrirOperacao(o))), 'Nenhuma operação aguardando saída.'),
    bloco('✉️ E-mails a encaminhar', emails.length, emails.map(o => linhaItem('✉️', `${o.rotuloTipo} · ${o.navio || ''}`, o.email?.status === 'ENVIADO' ? `No e-mail do líder desde ${quando(o.email.enviadoEm)}` : `Pronto para copiar${o.email?.whatsappEm ? ' · minuta no seu WhatsApp' : ''}`, () => abrirEmail(o), o.email?.status === 'ERRO' ? ' erro' : '')), 'Tudo encaminhado.'),
    emails.length ? el('div', {}, el('button', { class: 'btn', onclick: copiarTodosEmails }, `📋 Copiar todos os e-mails (${emails.length})`)) : null,
    el('section', { class: 'cartao' }, el('h2', { text: '🏁 Situação do terminal' }),
      el('div', { class: 'grade-2' },
        info('VTR', `${F.vtr?.modelo || ''} ${F.vtr?.placa || ''}\nKM inicial ${F.vtr?.kmInicial != null ? Number(F.vtr.kmInicial).toLocaleString('pt-BR') : '—'}`),
        info('OCR', `${F.sistemas?.ocrAssertividade || '—'} · ${F.sistemas?.ocrLeituras || '—'} leituras`),
        info('CFTV', F.sistemas?.cftv || 'S/A'),
        info('Controle de acesso', F.sistemas?.ca || 'S/A')),
      navioCartao('T-ORE', 'tore'), navioCartao('T-OIL', 'toil')),
    naEntrada ? el('section', { class: 'faixa info' },
      el('strong', { text: `📥 ${naEntrada} mensagem(ns) do grupo aguardando destino` }),
      el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { fecharPainel(); S.filtroEntrada = 'pendente'; trocarAba('entrada'); } }, 'Abrir Entrada'))) : null
  ]);
}

// ----------------------------- Escala --------------------------------
let escalaDados = null;
let timerEscala = null;

async function abrirEscala() {
  try { escalaDados = await api('GET', '/api/escala'); } catch (e) { return aviso(e.message, true); }
  desenharEscala();
}

function salvarEscalaDepois() {
  clearTimeout(timerEscala);
  timerEscala = setTimeout(async () => {
    try {
      const r = await api('PUT', '/api/escala/passagem', { secoes: escalaDados.secoes, removidos: escalaDados.removidos });
      escalaDados.editadoEm = r.editadoEm;
      const e = $('#escala-salvo'); if (e) e.textContent = 'Salvo ✓';
    } catch (e) { aviso(e.message, true); }
  }, 700);
}

function desenharEscala() {
  const d = escalaDados;
  const SECOES = [['digital', '1. Pendências da Digital (CFTV e infraestrutura)'], ['avisos', '2. Avisos e ações de acompanhamento'], ['ocorrencias', '3. Resumo das ocorrências'], ['atividades', '4. Resumo das atividades realizadas']];
  const secaoEd = (chave, titulo) => {
    const box = el('div', { class: 'lista' });
    const desenhar = focar => {
      const arr = d.secoes[chave];
      box.replaceChildren();
      if (!arr.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nada (sai "✓ S/A").' }));
      arr.forEach((it, i) => {
        const t = el('textarea', { rows: 1, value: it.texto, oninput: e => { it.texto = e.target.value; autoAltura(e.target); marcar(); } });
        box.append(el('div', { class: `item-escala${it.novo ? ' novo' : ''}` },
          el('div', {}, t, el('small', { text: `${it.origem || ''}${it.novo ? ' · novo desde a última edição' : ''}` })),
          el('div', { class: 'ferramentas' }, el('button', { class: 'btn-icone', title: 'Remover', onclick: () => { if (it.chave) d.removidos.push(it.chave); arr.splice(i, 1); desenhar(); marcar(); } }, '✕'))));
      });
      requestAnimationFrame(() => { box.querySelectorAll('textarea').forEach(autoAltura); if (focar) { const ts = box.querySelectorAll('textarea'); ts[ts.length - 1]?.focus(); } });
    };
    desenhar();
    return el('section', { class: 'cartao' }, el('h2', { text: titulo }), box,
      el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { d.secoes[chave].push({ id: uid(), chave: null, texto: '', origem: 'Manual' }); desenhar(true); } }, '+ Adicionar')));
  };
  const marcar = () => { const e = $('#escala-salvo'); if (e) e.textContent = 'Salvando…'; salvarEscalaDepois(); };

  abrirPainel('📦 Passagem da escala', [
    el('section', { class: 'cartao' },
      el('div', { class: 'cartao-topo' },
        el('div', {}, el('h2', { text: `Período: ${d.periodo}` }),
          el('p', { class: 'mudo pequeno', style: 'margin:4px 0 0', text: d.escala ? `Coletando desde ${d.escala.dataInicio} (iniciada por ${d.escala.iniciadaPor?.nome || '—'}). Tudo que foi registrado nos turnos aparece aqui.` : 'Nenhuma escala iniciada: inicie para o robô coletar desde o primeiro dia.' })),
        el('span', { id: 'escala-salvo', class: 'mudo pequeno', text: d.editadoEm ? 'Salvo ✓' : '' })),
      el('div', { class: 'linha' },
        ehLider() ? el('button', { class: 'btn pequeno', onclick: async () => {
          if (await confirmar('Iniciar nova escala?', 'A escala atual vai para o histórico e a coleta recomeça a partir de hoje.', 'Iniciar')) { escalaDados = await api('POST', '/api/escala/iniciar'); desenharEscala(); aviso('Nova escala iniciada ✓'); }
        } }, 'Iniciar nova escala') : null,
        d.editadoEm ? el('button', { class: 'btn fantasma pequeno', onclick: async () => {
          if (await confirmar('Restaurar o original?', 'Desfaz suas edições e remonta a partir dos registros.', 'Restaurar', true)) { escalaDados = await api('POST', '/api/escala/restaurar'); desenharEscala(); }
        } }, 'Restaurar original') : null)),
    ...SECOES.map(([k, t]) => secaoEd(k, t)),
    el('div', { class: 'barra-acoes', style: 'bottom:12px' },
      el('span', { class: 'estado-salvo', text: 'Edite à vontade: o texto sai como abaixo.' }),
      el('button', { class: 'btn', onclick: previaEscala }, '👁 Prévia'),
      ehLider() ? el('button', { class: 'btn primario', onclick: publicarEscala }, '🚀 Publicar') : null)
  ]);
}

async function previaEscala() {
  clearTimeout(timerEscala);
  await api('PUT', '/api/escala/passagem', { secoes: escalaDados.secoes, removidos: escalaDados.removidos }).catch(() => {});
  const t = await api('GET', '/api/escala/texto');
  abrirModal('Prévia da passagem da escala', [el('div', { class: 'previa' }, textoWhats(t.whatsapp))], [
    el('button', { class: 'btn', onclick: () => copiar(t.whatsapp) }, '📋 Copiar'),
    el('button', { class: 'btn', onclick: () => baixar(`Passagem_Escala_${agoraBR().data.replace(/\//g, '-')}.txt`, t.simples) }, '💾 .txt'),
    el('button', { class: 'btn', onclick: () => imprimir(`CCOS — Passagem da Escala · ${escalaDados.periodo}`, t.simples) }, '📄 PDF')
  ]);
}

async function publicarEscala() {
  try {
    clearTimeout(timerEscala);
    await api('PUT', '/api/escala/passagem', { secoes: escalaDados.secoes, removidos: escalaDados.removidos });
    await publicarGenerico({ titulo: 'Publicar a passagem da escala?', urlTexto: '/api/escala/texto', urlPublicar: '/api/escala/publicar', textoOk: 'Passagem da escala publicada ✓' });
  } catch (e) { aviso(e.message, true); }
}

// ----------------------------- Perfil --------------------------------
async function abrirPerfil() {
  const u = S.usuario;
  const [cNome, iNome] = campoLinha('Nome', u.nome);
  const [cTel, iTel] = campoLinha('Telefone (55 + DDD + número)', u.telefone, { tipo: 'tel' });
  abrirPainel('Meu perfil', [
    el('section', { class: 'cartao' },
      el('h2', { text: u.nome }), el('p', { class: 'mudo pequeno', style: 'margin:0', text: `${u.email} · ${u.rotuloPerfil}` }),
      cNome, cTel,
      el('div', { class: 'linha' },
        el('button', { class: 'btn primario', onclick: async () => { try { S.usuario = (await api('PUT', '/api/eu', { nome: iNome.value, telefone: iTel.value })).usuario; aviso('Perfil salvo ✓'); } catch (e) { aviso(e.message, true); } } }, 'Salvar'),
        el('button', { class: 'btn', onclick: () => pedirTrocaSenha(false) }, 'Trocar senha'))),
    ehLider() ? el('section', { class: 'cartao', id: 'perfil-whats' }, el('h2', { text: 'Meu WhatsApp' }), el('p', { class: 'mudo', text: 'Carregando…' })) : null
  ]);
  if (ehLider()) {
    S.assinaturaWhats = '';
    await atualizarMeuWhats();
    clearInterval(S.painelTimer);
    S.painelTimer = setInterval(atualizarMeuWhats, 3500);
  }
}

async function atualizarMeuWhats() {
  try {
    const w = await api('GET', '/api/whatsapp');
    const assinatura = `${w.estado}|${w.qrSvg ? w.qrSvg.length : 0}|${w.numero}|${w.erro}|${w.grupos.length}`;
    if (assinatura === S.assinaturaWhats) return;
    S.assinaturaWhats = assinatura;
    desenharMeuWhats(w);
  } catch (_) {}
}

function desenharMeuWhats(w) {
  const box = $('#perfil-whats'); if (!box) return;
  const filhos = [el('h2', { text: 'Meu WhatsApp' })];
  const conectar = el('button', { class: 'btn primario', onclick: async ev => {
    ev.target.disabled = true;
    try { await api('POST', '/api/whatsapp/conectar'); S.assinaturaWhats = ''; aviso('Iniciando conexão…'); setTimeout(atualizarMeuWhats, 1500); }
    catch (e) { aviso(e.message, true); ev.target.disabled = false; }
  } }, w.pareado ? 'Reconectar' : 'Conectar meu WhatsApp');

  if (!w.disponivel) {
    filhos.push(el('p', { class: 'mudo', text: 'Biblioteca do WhatsApp não instalada no servidor.' }));
  } else if (w.estado === 'CONECTADO') {
    filhos.push(
      el('div', { class: 'linha' }, el('span', { class: 'etiqueta ok', text: '● Conectado' }), el('span', { class: 'mudo', text: w.numero ? `+${w.numero}` : '' }), w.ehPlantao ? el('span', { class: 'etiqueta info', text: 'você está de plantão' }) : null),
      el('div', { class: 'pequeno' }, el('span', { class: 'mudo', text: 'Lendo: ' }), w.grupos.length ? w.grupos.map(g => g.nome).join(', ') : 'nenhum grupo — escolha abaixo'),
      el('div', { id: 'perfil-grupos' }, el('button', { class: 'btn', onclick: escolherMeusGrupos }, 'Escolher grupos')),
      el('div', {}, el('button', { class: 'btn perigo pequeno', onclick: async () => {
        if (await confirmar('Desconectar seu WhatsApp?', 'O robô para de usar seu número. Para voltar, será preciso ler o QR de novo.', 'Desconectar', true)) {
          await api('POST', '/api/whatsapp/desconectar'); S.assinaturaWhats = ''; atualizarMeuWhats();
        }
      } }, 'Desconectar')));
  } else if (w.estado === 'AGUARDANDO_PAREAMENTO') {
    const tel = el('input', { type: 'tel', placeholder: '5522998765432', value: S.usuario.telefone || '' });
    const saida = el('div');
    filhos.push(
      el('span', { class: 'etiqueta atencao', text: 'Aguardando conexão' }),
      el('ol', { style: 'margin:0;padding-left:20px', class: 'pequeno' },
        el('li', { text: 'No SEU celular: WhatsApp › Aparelhos conectados › Conectar um aparelho.' }),
        el('li', { text: 'Aponte a câmera para o QR abaixo.' })),
      w.qrSvg ? Object.assign(el('div', { class: 'qr' }), { innerHTML: w.qrSvg }) : el('p', { class: 'mudo pequeno', text: 'QR indisponível — use o código por número.' }),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Sem câmera? Gere um código e digite em "Conectar com número de telefone":' }),
      el('div', { class: 'linha', style: 'flex-wrap:nowrap' }, tel, el('button', { class: 'btn', onclick: async () => {
        try { const r = await api('POST', '/api/whatsapp/codigo', { numero: tel.value }); saida.replaceChildren(el('div', { class: 'codigo-pareamento', text: r.codigo })); }
        catch (e) { aviso(e.message, true); }
      } }, 'Gerar código')), saida);
  } else {
    const rot = { CONECTANDO: 'Conectando…', RECONECTANDO: 'Reconectando…', PAUSADO: w.pareado ? 'Pausado (sessão guardada)' : 'Não conectado', DESCONECTADO: 'Desconectado', ERRO: 'Erro' };
    filhos.push(el('span', { class: 'etiqueta atencao', text: rot[w.estado] || w.estado }));
    if (w.erro) filhos.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: w.erro }));
    if (!['CONECTANDO', 'RECONECTANDO'].includes(w.estado)) filhos.push(el('div', {}, conectar));
  }
  filhos.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: `No plano gratuito ficam ligados até ${w.maxAtivas} WhatsApps (o líder de plantão e um reserva). Os outros ficam guardados e religam sozinhos ao assumir o plantão.` }));
  box.replaceChildren(...filhos);
}

async function escolherMeusGrupos() {
  const box = $('#perfil-grupos');
  try {
    const [{ grupos }, w] = await Promise.all([api('GET', '/api/whatsapp/grupos'), api('GET', '/api/whatsapp')]);
    const marcados = new Set(w.grupos.map(g => g.id));
    const busca = el('input', { type: 'search', placeholder: 'Filtrar grupos…' });
    const lista = el('div', { class: 'lista-grupos' });
    const desenhar = () => {
      const t = semAcento(busca.value).toLowerCase();
      lista.replaceChildren(...grupos.filter(g => !t || semAcento(g.nome).toLowerCase().includes(t)).map(g => el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: marcados.has(g.id), onchange: e => { e.target.checked ? marcados.add(g.id) : marcados.delete(g.id); } }),
        el('span', {}, g.nome, el('span', { class: 'mudo pequeno', text: `  ${g.membros} membros` })))));
    };
    busca.addEventListener('input', desenhar); desenhar();
    box.replaceChildren(
      el('p', { class: 'mudo pequeno', style: 'margin:0 0 6px', text: 'Marque só os grupos de trabalho (ex.: EQUIPE AZUL - US FERROPORT). Os demais nunca são lidos.' }),
      busca, lista,
      el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn primario', onclick: async () => {
        const nomes = {}; grupos.forEach(g => { if (marcados.has(g.id)) nomes[g.id] = g.nome; });
        await api('PUT', '/api/whatsapp/grupos', { grupos: [...marcados], nomes });
        aviso('Grupos salvos ✓'); S.assinaturaWhats = ''; atualizarMeuWhats(); carregarConfig();
      } }, 'Salvar grupos')));
  } catch (e) { aviso(e.message, true); }
}

// ----------------------------- Usuários (admin) ----------------------
async function abrirUsuarios() {
  let lista;
  try { lista = (await api('GET', '/api/usuarios')).usuarios; } catch (e) { return aviso(e.message, true); }
  const mostrarSenha = (nome, senha) => abrirModal('Senha provisória', [
    el('p', { text: `Envie para ${nome} por um canal seguro. No primeiro acesso a pessoa cria a própria senha.` }),
    el('div', { class: 'senha-box', text: senha })
  ], [el('button', { class: 'btn', onclick: () => copiar(senha) }, '📋 Copiar'), el('button', { class: 'btn primario', 'data-fechar': true }, 'Pronto')]);

  const cartoes = lista.map(x => {
    const perfil = el('select', {}, Object.entries(S.meta.perfis).map(([k, v]) => el('option', { value: k, text: v })));
    perfil.value = x.perfil;
    perfil.addEventListener('change', async () => { try { await api('PUT', `/api/usuarios/${x.id}`, { perfil: perfil.value }); aviso('Perfil alterado ✓'); } catch (e) { aviso(e.message, true); perfil.value = x.perfil; } });
    return el('div', { class: 'usuario-card' },
      el('div', { class: 'cartao-topo' },
        el('div', {}, el('strong', { text: x.nome }), el('div', { class: 'mudo pequeno', text: x.email })),
        el('span', { class: `etiqueta ${x.ativo ? (x.temSenha ? 'ok' : 'atencao') : 'urgente'}`, text: !x.ativo ? 'Desativado' : x.temSenha ? (x.trocarSenha ? 'Senha provisória' : 'Ativo') : 'Sem senha' })),
      el('div', { class: 'grade-2' }, el('label', { class: 'campo' }, 'Perfil', perfil),
        el('div', { class: 'campo' }, 'WhatsApp', el('span', { text: x.whatsapp.pareado ? `+${x.whatsapp.numero || ''} · ${x.whatsapp.estado === 'CONECTADO' ? 'ligado' : 'guardado'}` : '—' }))),
      el('div', { class: 'linha' },
        el('button', { class: 'btn pequeno', onclick: async () => { try { const r = await api('POST', `/api/usuarios/${x.id}/senha`); mostrarSenha(x.nome, r.senhaProvisoria); } catch (e) { aviso(e.message, true); } } }, x.temSenha ? 'Gerar senha provisória' : 'Criar senha provisória'),
        el('button', { class: 'btn fantasma pequeno', onclick: async () => {
          if (x.ativo && !await confirmar(`Desativar ${x.nome}?`, 'A pessoa perde o acesso e o WhatsApp dela é desconectado do robô.', 'Desativar', true)) return;
          try { await api('PUT', `/api/usuarios/${x.id}`, { ativo: !x.ativo }); abrirUsuarios(); } catch (e) { aviso(e.message, true); }
        } }, x.ativo ? 'Desativar' : 'Reativar')));
  });

  const novo = () => {
    const [c1, iNome] = campoLinha('Nome', '', { autofocus: true });
    const [c2, iEmail] = campoLinha('E-mail (obrigatório — recebe os e-mails do robô)', '', { tipo: 'email' });
    const [c3, iTel] = campoLinha('Telefone (opcional)', '', { tipo: 'tel' });
    const perfil = el('select', {}, Object.entries(S.meta.perfis).map(([k, v]) => el('option', { value: k, text: v })));
    perfil.value = 'OPERADOR';
    abrirModal('Novo usuário', [c1, c2, c3, el('label', { class: 'campo' }, 'Perfil', perfil),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Líder: assume o plantão, conecta o WhatsApp e publica. Operador: registra e trata a entrada, não publica.' })],
    botoesSalvar(async () => {
      const r = await api('POST', '/api/usuarios', { nome: iNome.value, email: iEmail.value, telefone: iTel.value, perfil: perfil.value });
      mostrarSenha(r.usuario.nome, r.senhaProvisoria);
      abrirUsuarios();
    }, 'Cadastrar'));
  };

  abrirPainel('👥 Usuários', [
    el('div', {}, el('button', { class: 'btn primario', onclick: novo }, '+ Novo usuário')),
    ...cartoes
  ]);
}

// ----------------------------- Configurações (admin) -----------------
async function abrirConfig() {
  let grupos = [];
  try { await carregarConfig(); grupos = (await api('GET', '/api/whatsapp/grupos-conhecidos')).grupos; } catch (e) { return aviso(e.message, true); }
  const cfg = clone(S.config);
  const L = (rotulo, chave, opts = {}) => el('label', { class: 'campo' }, rotulo, el('input', { type: opts.tipo || 'text', value: cfg[chave] ?? '', placeholder: opts.placeholder, oninput: e => { cfg[chave] = e.target.value; } }));
  const pub = el('select', { onchange: e => { cfg.grupoPublicacao = e.target.value; } }, el('option', { value: '', text: '— escolha —' }), grupos.map(g => el('option', { value: g.id, text: g.nome })));
  pub.value = cfg.grupoPublicacao || '';
  const alertas = el('input', { type: 'checkbox', checked: cfg.alertasAtivos, onchange: e => { cfg.alertasAtivos = e.target.checked; } });
  const base = el('textarea', { rows: 3, value: (cfg.atividadesBase || []).join('\n'), oninput: e => { cfg.atividadesBase = e.target.value.split('\n'); autoAltura(e.target); } });
  const navios = el('textarea', { rows: 8, value: (cfg.navios || []).map(n => `${n.nome} ; ${n.terminal}`).join('\n'), oninput: e => {
    cfg.navios = e.target.value.split('\n').map(l => l.split(/[;=]/)).filter(p => p[0].trim()).map(([nome, term]) => ({ nome: nome.trim(), terminal: (term || 'T-ORE').trim() })); autoAltura(e.target);
  } });
  const emailInfo = S.meta.email.ativo ? el('span', { class: 'etiqueta ok', text: '● E-mail do robô ativo' }) : el('span', { class: 'etiqueta atencao', style: 'white-space:normal', text: S.meta.email.motivo });

  abrirPainel('⚙️ Configurações', [
    el('section', { class: 'cartao' }, el('h2', { text: 'Publicação' }),
      el('label', { class: 'campo' }, 'Grupo onde o relatório é publicado', pub),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'A lista mostra os grupos escolhidos pelos líderes em "Meu perfil". Publica pelo WhatsApp de quem está de plantão.' })),
    el('section', { class: 'cartao' }, el('h2', { text: 'E-mails de bordo' }), emailInfo,
      L('Encaminhar para (lista oficial, separe por ;)', 'emailDestinatarios', { placeholder: 'operacoes@ferroport.com.br; supervisao@ferroport.com.br' }),
      L('Cópia (Cc)', 'emailCopia'),
      L('Se ninguém estiver de plantão, enviar para', 'emailPadrao', { placeholder: 'ruddgero.ribeiro@ferroport.com.br' }),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!cfg.emailDiretoOficial, onchange: e => { cfg.emailDiretoOficial = e.target.checked; } }),
        'Enviar direto para a lista oficial (sem revisão do líder; o líder vai em cópia)'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: cfg.minutaNoWhatsapp !== false, onchange: e => { cfg.minutaNoWhatsapp = e.target.checked; } }),
        'Se o e-mail não puder sair, mandar a minuta no WhatsApp do líder'),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Os e-mails são gerados sozinhos (um por navio) quando a operação tem horário de saída. Padrão: vão para o líder de plantão conferir e encaminhar.' })),
    el('section', { class: 'cartao' }, el('h2', { text: 'Alerta de emergência' }),
      el('label', { class: 'check' }, alertas, 'Enviar alerta no privado quando houver possível emergência'),
      L('Número que recebe (55 + DDD + número)', 'alertaNumero', { tipo: 'tel', placeholder: '5522998765432' })),
    el('section', { class: 'cartao' }, el('h2', { text: 'Padrões do relatório' }),
      el('div', { class: 'grade-2' }, L('Viatura', 'vtrModelo'), L('Placa da viatura', 'vtrPlaca')),
      el('label', { class: 'campo' }, 'Atividades fixas de todo turno (uma por linha)', base)),
    el('section', { class: 'cartao' }, el('h2', { text: 'Navios conhecidos' }),
      el('label', { class: 'campo' }, 'Um por linha: NOME ; TERMINAL (T-ORE ou T-OIL)', navios)),
    el('div', {}, el('button', { class: 'btn primario largo', onclick: async () => {
      try { S.config = (await api('PUT', '/api/config', { config: cfg })).config; aviso('Configurações salvas ✓'); } catch (e) { aviso(e.message, true); }
    } }, 'Salvar configurações')),
    el('section', { class: 'cartao' }, el('h2', { text: 'Registro de ações' }),
      el('div', { id: 'cfg-auditoria' }, el('button', { class: 'btn pequeno', onclick: async () => {
        const { itens } = await api('GET', '/api/auditoria');
        $('#cfg-auditoria').replaceChildren(el('div', { class: 'texto-bruto' }, itens.map(i => `${i.data} ${i.hora} · ${i.por} · ${i.acao}${i.detalhe ? ' — ' + i.detalhe : ''}`).join('\n')));
      } }, 'Ver últimas ações'))),
    el('p', { class: 'mudo pequeno', text: `Dados guardados em: ${S.meta.armazenamento === 'firestore' ? 'Firebase' : 'pasta "dados" do servidor'}` })
  ]);
  requestAnimationFrame(() => { autoAltura(base); autoAltura(navios); });
}

// ----------------------------- Histórico -----------------------------
async function abrirHistorico() {
  try {
    const { itens } = await api('GET', '/api/historico');
    abrirPainel('🗃️ Rascunhos de turnos arquivados', itens.length ? itens.map(h => el('details', { class: 'cartao historico' },
      el('summary', { text: `${h.data} · ${h.turno}${h.publicadoEm ? ' · publicado' : ''}` }),
      el('div', { class: 'texto-bruto', style: 'margin:8px 0', text: h.texto }),
      el('button', { class: 'btn pequeno', onclick: () => copiar(h.texto) }, 'Copiar'))) : [el('p', { class: 'mudo', text: 'Nenhum turno arquivado ainda.' })]);
  } catch (e) { aviso(e.message, true); }
}

// ------------------------------ Início ------------------------------
(async function iniciar() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const s = await api('GET', '/api/sessao');
    S.usuario = s.usuario;
    if (!s.usuario) return mostrarLogin();
    if (s.usuario.trocarSenha) { esconderCapa(); return pedirTrocaSenha(true); }
    entrar();
  } catch (_) { mostrarLogin(); }
})();

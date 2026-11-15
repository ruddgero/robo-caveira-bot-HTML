'use strict';
// =====================================================================
// CAVEIRA BOT · Painel do CCOS
// Tudo que aparece na tela vem do servidor; o texto publicado é
// exatamente o da Prévia. Nenhum dado de exemplo.
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
  const mesmoDia = f({ day: '2-digit', month: '2-digit', year: 'numeric' }) === agoraBR().data;
  const hora = f({ hour: '2-digit', minute: '2-digit', hour12: false });
  return mesmoDia ? `hoje às ${hora}` : `${f({ day: '2-digit', month: '2-digit' })} às ${hora}`;
}

function autoAltura(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px';
}

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

// Texto do WhatsApp com *negrito* → nós DOM seguros (sem innerHTML)
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
  if (!r.ok) { const e = new Error(d.erro || `Erro ${r.status}`); e.status = r.status; throw e; }
  return d;
}

// ------------------------------ Estado ------------------------------
const S = {
  aba: 'turno', ficha: null, versao: 0, conferencia: [],
  entrada: [], relatorioUS: null, config: null, estado: null,
  filtro: 'pendente', busca: '',
  sujo: false, salvando: false, timerSalvar: null, timerEstado: null
};

const DESTINOS = {
  ATIVIDADE: { rotulo: 'Atividade', ic: '📝', desc: 'Seção 4 · Atividades realizadas' },
  OCORRENCIA: { rotulo: 'Ocorrência', ic: '🚨', desc: 'Seção 7 · Ocorrências' },
  AVISO: { rotulo: 'Aviso', ic: '📌', desc: 'Seção 5 · Avisos e acompanhamento' },
  NAVIO: { rotulo: 'Navios', ic: '🚢', desc: 'Seção 6 · Movimentação de navios' },
  OPERACAO: { rotulo: 'Operação de bordo', ic: '✉️', desc: 'Rancho, tripulantes, resíduos… gera o e-mail' },
  SAIDA: { rotulo: 'Saída de veículo', ic: '🏁', desc: 'Fecha uma operação de bordo em andamento' }
};

const TIPOS_OPERACAO = [
  'MOVIMENTAÇÃO DE TRIPULAÇÃO', 'FORNECIMENTO DE RANCHO', 'FORNECIMENTO DE MATERIAIS E EQUIPAMENTOS',
  'RETIRADA DE RESÍDUOS', 'FORNECIMENTO DE ÁGUA POTÁVEL', 'ABASTECIMENTO DE COMBUSTÍVEL', 'OUTRA OPERAÇÃO'
];

function tipoDoTexto(t) {
  const n = semAcento(t).toLowerCase();
  if (/tripula/.test(n)) return TIPOS_OPERACAO[0];
  if (/rancho|provis/.test(n)) return TIPOS_OPERACAO[1];
  if (/residuo/.test(n)) return TIPOS_OPERACAO[3];
  if (/agua/.test(n)) return TIPOS_OPERACAO[4];
  if (/bunker|combustivel/.test(n)) return TIPOS_OPERACAO[5];
  if (/dta|materia|pecas|sobressalente|equipamento/.test(n)) return TIPOS_OPERACAO[2];
  return TIPOS_OPERACAO[6];
}

const operacoesAbertas = () => (S.ficha?.operacoes || []).filter(o => !o.horaFinal);

// ------------------------------ Janela ------------------------------
function abrirModal(titulo, corpo, rodape = []) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').replaceChildren(...[].concat(corpo).filter(Boolean));
  $('#modal-rodape').replaceChildren(...[].concat(rodape).filter(Boolean));
  $('#modal').hidden = false;
  requestAnimationFrame(() => {
    $('#modal-corpo').querySelectorAll('textarea').forEach(autoAltura);
    const foco = $('#modal-corpo [autofocus]'); if (foco) foco.focus();
  });
}
function fecharModal() { $('#modal').hidden = true; }
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

// ------------------------------ Login -------------------------------
function mostrarLogin() {
  clearInterval(S.timerEstado);
  $('#app').hidden = true;
  $('#painel-config').hidden = true;
  fecharModal();
  $('#tela-login').hidden = false;
  setTimeout(() => $('#login-senha').focus(), 50);
}

$('#form-login').addEventListener('submit', async ev => {
  ev.preventDefault();
  const erro = $('#login-erro'); erro.hidden = true;
  try {
    await api('POST', '/api/login', { senha: $('#login-senha').value });
    $('#login-senha').value = '';
    entrar();
  } catch (e) { erro.textContent = e.message; erro.hidden = false; }
});

async function entrar() {
  $('#tela-login').hidden = true;
  $('#app').hidden = false;
  await carregarTudo();
  trocarAba(S.aba);
  clearInterval(S.timerEstado);
  S.timerEstado = setInterval(atualizarEstado, 8000);
}

async function carregarTudo() {
  const [f, en, rel, cfg, est] = await Promise.all([
    api('GET', '/api/ficha'), api('GET', '/api/entrada'), api('GET', '/api/relatorio-us'),
    api('GET', '/api/config'), api('GET', '/api/estado')
  ]);
  S.ficha = f.ficha; S.versao = f.ficha.versao || 0; S.conferencia = f.conferencia;
  S.entrada = en.itens; S.relatorioUS = rel.relatorio; S.config = cfg.config; S.estado = est;
  desenharTopo();
}

// --------------------------- Topo e abas ----------------------------
function desenharTopo() {
  const f = S.ficha;
  $('#topo-turno').textContent = f ? `${f.turno} · ${f.data}` : '';
  const w = S.estado?.whatsapp?.estado || 'DESLIGADO';
  const mapa = {
    CONECTADO: ['ok', 'Conectado'], AGUARDANDO_PAREAMENTO: ['atencao', 'Conectar'],
    CONECTANDO: ['atencao', 'Conectando'], RECONECTANDO: ['atencao', 'Reconectando']
  };
  const [classe, txt] = mapa[w] || ['falha', 'Offline'];
  const p = $('#pilula-whats');
  p.className = 'pilula ' + classe;
  p.querySelector('.txt').textContent = txt;
  const b = $('#badge-entrada');
  const n = S.estado?.pendentes || 0;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
  b.style.background = S.estado?.urgentes ? 'var(--vermelho)' : 'var(--primario)';
}

function trocarAba(nome) {
  S.aba = ['turno', 'entrada', 'relatorio'].includes(nome) ? nome : 'turno';
  document.querySelectorAll('.abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === S.aba));
  document.querySelectorAll('.aba').forEach(s => { s.hidden = s.id !== `aba-${S.aba}`; });
  if (S.aba === 'turno') desenharTurno();
  if (S.aba === 'entrada') desenharEntrada();
  if (S.aba === 'relatorio') desenharRelatorio();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.abas button').forEach(b => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
$('#btn-config').addEventListener('click', abrirConfig);
$('#pilula-whats').addEventListener('click', abrirConfig);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-fechar]')) fecharModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalAberto()) fecharModal(); });

// ------------------------ Atualização periódica ---------------------
async function atualizarEstado() {
  try {
    const anterior = S.estado;
    S.estado = await api('GET', '/api/estado');
    desenharTopo();

    if (S.estado.relatorioUS?.capturadoEm && S.estado.relatorioUS.capturadoEm !== anterior?.relatorioUS?.capturadoEm) {
      S.relatorioUS = (await api('GET', '/api/relatorio-us')).relatorio;
      if (anterior?.relatorioUS?.capturadoEm || anterior) aviso('📑 Novo relatório da equipe anterior capturado');
      if (S.aba === 'turno' && !modalAberto()) desenharTurno();
    }
    if (S.estado.pendentes !== anterior?.pendentes || S.estado.urgentes !== anterior?.urgentes) {
      S.entrada = (await api('GET', '/api/entrada')).itens;
      if (S.aba === 'entrada' && !modalAberto()) desenharListaEntrada();
      if (S.estado.urgentes > (anterior?.urgentes || 0)) aviso('🚨 Mensagem urgente na Entrada', true);
    }
    const editando = document.activeElement && $('#aba-relatorio').contains(document.activeElement);
    if (S.estado.fichaVersao !== S.versao && !S.sujo && !S.salvando && !editando && !modalAberto()) {
      await recarregarFicha();
    }
  } catch (_) { /* sem conexão: tenta de novo no próximo ciclo */ }
}

async function recarregarFicha() {
  const f = await api('GET', '/api/ficha');
  S.ficha = f.ficha; S.versao = f.ficha.versao || 0; S.conferencia = f.conferencia;
  desenharTopo();
  if (S.aba === 'relatorio') desenharRelatorio();
  if (S.aba === 'turno') desenharTurno();
}

// ------------------------ Salvar a ficha ----------------------------
function agendarSalvar() {
  S.sujo = true;
  marcarEstadoSalvo('Salvando…');
  clearTimeout(S.timerSalvar);
  S.timerSalvar = setTimeout(salvarFicha, 700);
}

async function salvarFicha() {
  clearTimeout(S.timerSalvar);
  if (S.salvando) { S.timerSalvar = setTimeout(salvarFicha, 300); return; }
  if (!S.sujo) return;
  S.salvando = true; S.sujo = false;
  try {
    const r = await api('PUT', '/api/ficha', { ficha: S.ficha, versao: S.versao });
    S.versao = r.ficha.versao;
    S.ficha.versao = r.ficha.versao;
    S.ficha.atualizadoEm = r.ficha.atualizadoEm;
    S.conferencia = r.conferencia;
    marcarEstadoSalvo('Salvo ✓');
    desenharConferencia();
    desenharTopo();
  } catch (e) {
    if (e.status === 409) { aviso(e.message, true); await recarregarFicha(); }
    else { S.sujo = true; marcarEstadoSalvo('Não salvo — tentando de novo'); S.timerSalvar = setTimeout(salvarFicha, 4000); }
  } finally { S.salvando = false; }
}

async function salvarAgora() {
  S.sujo = true;
  await salvarFicha();
  while (S.salvando) await new Promise(r => setTimeout(r, 100));
}

function marcarEstadoSalvo(txt) {
  const e = $('#estado-salvo');
  if (e) e.textContent = txt;
}

// Edita a ficha a partir de qualquer tela e salva na hora
async function alterarFicha(fn) {
  fn(S.ficha);
  await salvarAgora();
  if (S.aba === 'relatorio') desenharRelatorio();
}

// =====================================================================
// ABA 1 · TURNO
// =====================================================================
function desenharTurno() {
  const c = $('#aba-turno');
  c.replaceChildren();
  if (S.estado && !S.estado.configurado) {
    c.append(el('div', { class: 'cartao' },
      el('h2', { text: '👋 Falta configurar o WhatsApp' }),
      el('p', { class: 'mudo', text: 'Conecte o aparelho e escolha o grupo da Equipe Azul para o robô começar a ler as mensagens e o relatório da US.' }),
      el('div', {}, el('button', { class: 'btn primario', onclick: abrirConfig }, 'Abrir configurações'))
    ));
  }
  c.append(cartaoRelatorioUS(), cartaoMeuTurno());
}

function cartaoRelatorioUS() {
  const r = S.relatorioUS;
  if (!r) {
    return el('div', { class: 'cartao' },
      el('h2', { text: 'Relatório da equipe anterior' }),
      el('p', { class: 'mudo', text: 'Quando o "RELATÓRIO DO TURNO" for postado no grupo, ele aparece aqui automaticamente. Se foi postado antes do robô ligar, cole o texto.' }),
      el('div', {}, el('button', { class: 'btn', onclick: abrirColarRelatorio }, '📋 Colar relatório'))
    );
  }
  const d = r.dados;
  const herdado = r.herdadoEm && r.herdadoEm >= r.capturadoEm;
  const resumo = [
    ['KM final da VTR', d.vtr.kmFinal != null ? d.vtr.kmFinal.toLocaleString('pt-BR') : '—'],
    ['OCR', d.sistemas.ocrAssertividade ? `${d.sistemas.ocrAssertividade} · ${d.sistemas.ocrLeituras || '?'} leituras` : '—'],
    ['Equipe assumindo', d.equipes.assumindo || '—']
  ];
  return el('div', { class: 'cartao' },
    el('div', { class: 'cartao-topo' },
      el('div', {},
        el('h3', { text: 'Relatório da equipe anterior' }),
        el('h2', { text: `Turno ${d.turno || '?'} · ${d.data || 'sem data'}` }),
        el('p', { class: 'mudo pequeno', style: 'margin:4px 0 0', text: `${r.manual ? 'Colado manualmente' : `Postado por ${r.autor || '?'}${r.grupoNome ? ' em ' + r.grupoNome : ''}`} · capturado ${quando(r.capturadoEm)}` })
      ),
      el('span', { class: `etiqueta ${herdado ? 'ok' : 'info'}`, text: herdado ? 'Já herdado' : 'Novo' })
    ),
    el('div', { class: 'grade-3' }, resumo.map(([k, v]) => el('div', {}, el('div', { class: 'mudo pequeno', text: k }), el('div', { text: v })))),
    el('div', { class: 'linha' },
      r.encontrados.map(x => el('span', { class: 'etiqueta ok', text: '✓ ' + x })),
      r.faltando.map(x => el('span', { class: 'etiqueta atencao', text: '? ' + x }))
    ),
    r.faltando.length ? el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Os itens com "?" não foram encontrados no texto — confira e preencha no Relatório depois de herdar.' }) : null,
    el('details', {}, el('summary', { class: 'mudo pequeno', style: 'cursor:pointer', text: 'Ver texto original' }), el('div', { class: 'texto-bruto', style: 'margin-top:8px', text: r.texto })),
    el('div', { class: 'linha' },
      el('button', { class: 'btn primario', onclick: herdar }, herdado ? 'Herdar novamente' : '📥 Herdar e começar meu turno'),
      el('button', { class: 'btn fantasma', onclick: abrirColarRelatorio }, 'Colar outro')
    )
  );
}

async function herdar() {
  const d = S.relatorioUS.dados;
  const novoTurno = d.turno ? (d.turno === 'DIURNO' ? 'NOTURNO' : 'DIURNO') : 'conforme o horário';
  const ok = await confirmar('Herdar o relatório?', [
    el('p', { text: `Vai começar um turno ${novoTurno} novo com:` }),
    el('ul', { style: 'margin:0;padding-left:20px' },
      el('li', { text: `KM inicial da VTR: ${d.vtr.kmFinal != null ? d.vtr.kmFinal.toLocaleString('pt-BR') : 'não encontrado'}` }),
      el('li', { text: 'Sistemas (CFTV, CA, OCR) e navios do relatório anterior' }),
      el('li', { text: 'Avisos em aberto mantidos; atividades e ocorrências zeradas' }),
      el('li', { text: `Equipe saindo: ${d.equipes.assumindo || '(preencher)'}` })
    ),
    el('p', { class: 'mudo pequeno', text: 'O turno atual vai para o histórico.' })
  ], 'Herdar');
  if (!ok) return;
  try {
    const r = await api('POST', '/api/ficha/herdar');
    S.ficha = r.ficha; S.versao = r.ficha.versao;
    S.relatorioUS = (await api('GET', '/api/relatorio-us')).relatorio;
    const f = await api('GET', '/api/ficha'); S.conferencia = f.conferencia;
    desenharTopo();
    aviso('Turno iniciado com os dados herdados ✓');
    trocarAba('relatorio');
  } catch (e) { aviso(e.message, true); }
}

function abrirColarRelatorio() {
  const txt = el('textarea', { rows: 12, placeholder: 'Cole aqui o texto completo do "RELATÓRIO DO TURNO"…', autofocus: true });
  abrirModal('Colar relatório da equipe anterior', [
    el('p', { class: 'mudo pequeno', text: 'Use quando o relatório foi postado antes do robô ligar, ou em outro grupo.' }), txt
  ], [
    el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'),
    el('button', {
      class: 'btn primario', onclick: async () => {
        try {
          S.relatorioUS = (await api('POST', '/api/relatorio-us', { texto: txt.value })).relatorio;
          fecharModal(); desenharTurno(); aviso('Relatório lido ✓');
        } catch (e) { aviso(e.message, true); }
      }
    }, 'Ler relatório')
  ]);
}

function cartaoMeuTurno() {
  const f = S.ficha;
  const ki = f.vtr?.kmInicial, kf = f.vtr?.kmFinal;
  const stats = [
    ['KM rodados', ki != null && kf != null ? Math.max(0, kf - ki) : '—'],
    ['Atividades', (f.atividades || []).length],
    ['Ocorrências', (f.ocorrencias || []).length],
    ['Avisos', (f.avisos || []).length],
    ['Operações abertas', operacoesAbertas().length],
    ['Entrada pendente', S.estado?.pendentes ?? 0]
  ];
  return el('div', { class: 'cartao' },
    el('div', { class: 'cartao-topo' },
      el('div', {},
        el('h3', { text: 'Meu turno' }),
        el('h2', { text: `${f.turno} · ${f.data}` }),
        el('p', { class: 'mudo pequeno', style: 'margin:4px 0 0', text: f.herdadoDe ? `Herdado do turno ${f.herdadoDe.turno || ''} ${f.herdadoDe.data || ''} (${f.herdadoDe.autor || 'equipe anterior'})` : 'Turno sem herança' })
      ),
      el('span', { class: `etiqueta ${f.publicadoEm ? 'ok' : ''}`, text: f.publicadoEm ? `Publicado ${quando(f.publicadoEm)}` : 'Não publicado' })
    ),
    el('div', { class: 'grade-3' }, stats.map(([k, v]) => el('div', {}, el('div', { class: 'destaque', text: v }), el('div', { class: 'mudo pequeno', text: k })))),
    S.conferencia.length ? el('div', { class: 'alertas' }, S.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
    el('div', { class: 'linha' },
      el('button', { class: 'btn primario', onclick: () => trocarAba('relatorio') }, 'Abrir relatório'),
      el('button', { class: 'btn', onclick: () => trocarAba('entrada') }, 'Ver entrada'),
      el('button', { class: 'btn fantasma', onclick: novaEmBranco }, 'Começar turno em branco')
    )
  );
}

async function novaEmBranco() {
  const ok = await confirmar('Começar um turno em branco?', 'O turno atual vai para o histórico. Mantém os avisos em aberto e o KM final como KM inicial.', 'Começar');
  if (!ok) return;
  try {
    const r = await api('POST', '/api/ficha/nova');
    S.ficha = r.ficha; S.versao = r.ficha.versao;
    await recarregarFicha();
    trocarAba('relatorio');
  } catch (e) { aviso(e.message, true); }
}

// =====================================================================
// ABA 2 · ENTRADA (mensagens do grupo para triagem)
// =====================================================================
function desenharEntrada() {
  const c = $('#aba-entrada');
  const cont = s => S.entrada.filter(i => i.status === s).length;
  const filtros = [['pendente', `Pendentes (${cont('pendente')})`], ['usado', 'Tratadas'], ['ignorado', 'Ignoradas'], ['todas', 'Todas']];
  c.replaceChildren(
    el('div', { class: 'filtros' }, filtros.map(([v, t]) =>
      el('button', { class: 'filtro' + (S.filtro === v ? ' ativo' : ''), onclick: () => { S.filtro = v; desenharEntrada(); } }, t))),
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
    .filter(i => S.filtro === 'todas' || i.status === S.filtro)
    .filter(i => !termo || semAcento(`${i.texto} ${i.autor} ${i.grupoNome}`).toLowerCase().includes(termo))
    .sort((a, b) => (S.filtro === 'pendente' ? (b.urgente - a.urgente) : 0) || b.ts - a.ts);
  if (!itens.length) {
    const msg = !S.estado?.configurado ? 'Escolha os grupos em Configurações para começar a receber mensagens.'
      : S.filtro === 'pendente' ? 'Nada pendente. As mensagens operacionais do grupo aparecem aqui.' : 'Nenhuma mensagem aqui.';
    box.replaceChildren(el('div', { class: 'vazio' }, el('span', { class: 'ic', text: '📭' }), msg));
    return;
  }
  box.replaceChildren(...itens.slice(0, 150).map(cartaoMensagem));
}

function cartaoMensagem(item) {
  const hoje = agoraBR().data;
  let sug = item.sugestao in DESTINOS ? item.sugestao : 'ATIVIDADE';
  if (sug === 'SAIDA' && !operacoesAbertas().length) sug = 'ATIVIDADE';
  const acoes = [];
  if (item.status === 'pendente') {
    acoes.push(
      el('button', { class: 'btn fantasma pequeno', onclick: () => marcarItem(item, 'ignorado') }, 'Ignorar'),
      el('button', { class: 'btn pequeno', onclick: () => escolherDestino(item) }, 'Outro destino'),
      el('button', { class: 'btn primario pequeno', onclick: () => abrirDestino(item, sug) }, `${DESTINOS[sug].ic} ${DESTINOS[sug].rotulo}`)
    );
  } else if (item.status === 'usado') {
    acoes.push(
      el('button', { class: 'btn fantasma pequeno', onclick: () => marcarItem(item, 'pendente') }, 'Voltar p/ pendentes'),
      el('button', { class: 'btn pequeno', onclick: () => escolherDestino(item) }, 'Usar de novo')
    );
  } else {
    acoes.push(el('button', { class: 'btn pequeno', onclick: () => marcarItem(item, 'pendente') }, 'Restaurar'));
  }
  return el('article', { class: `msg${item.urgente && item.status === 'pendente' ? ' urgente' : ''}${item.status !== 'pendente' ? ' tratada' : ''}` },
    el('div', { class: 'msg-topo' },
      el('span', {}, el('strong', { text: item.autor || 'Sem nome' }), item.grupoNome ? ` · ${item.grupoNome}` : ''),
      el('span', { text: `${item.data !== hoje ? item.data.slice(0, 5) + ' ' : ''}${item.hora}` })
    ),
    (item.urgente || item.editado || item.destino) ? el('div', { class: 'linha' },
      item.urgente ? el('span', { class: 'etiqueta urgente', text: '🚨 Possível emergência' }) : null,
      item.editado ? el('span', { class: 'etiqueta', text: 'editada' }) : null,
      item.destino ? el('span', { class: 'etiqueta ok', text: '→ ' + item.destino }) : null
    ) : null,
    el('div', { class: 'msg-texto', text: item.texto }),
    el('div', { class: 'msg-acoes' }, acoes)
  );
}

async function marcarItem(item, status, destino) {
  try {
    const r = await api('POST', `/api/entrada/${encodeURIComponent(item.id)}`, { status, destino });
    Object.assign(item, r.item);
    S.estado.pendentes = S.entrada.filter(i => i.status === 'pendente').length;
    S.estado.urgentes = S.entrada.filter(i => i.status === 'pendente' && i.urgente).length;
    desenharTopo();
    if (S.aba === 'entrada') desenharEntrada();
  } catch (e) { aviso(e.message, true); }
}

function escolherDestino(item) {
  const opcoes = Object.entries(DESTINOS)
    .filter(([k]) => k !== 'SAIDA' || operacoesAbertas().length)
    .map(([k, d]) => el('button', { class: 'opcao-destino', onclick: () => abrirDestino(item, k) },
      el('span', { class: 'ic', text: d.ic }), el('span', {}, el('strong', { text: d.rotulo }), el('small', { text: d.desc }))));
  abrirModal('Para onde vai esta informação?', [el('div', { class: 'citacao', text: item.texto }), el('div', { class: 'opcoes-destino' }, opcoes)]);
}

function campoTexto(rotulo, valor, opts = {}) {
  const t = el('textarea', { rows: opts.linhas || 3, value: valor || '', placeholder: opts.placeholder, autofocus: opts.autofocus, oninput: e => autoAltura(e.target) });
  return [el('label', { class: 'campo' }, rotulo, t), t];
}
function campoLinha(rotulo, valor, opts = {}) {
  const i = el('input', { type: opts.tipo || 'text', value: valor ?? '', placeholder: opts.placeholder, autofocus: opts.autofocus });
  return [el('label', { class: 'campo' }, rotulo, i), i];
}

function botoesSalvar(onSalvar, rotulo = 'Adicionar') {
  return [
    el('button', { class: 'btn fantasma', 'data-fechar': true }, 'Cancelar'),
    el('button', { class: 'btn primario', onclick: async ev => { ev.target.disabled = true; try { await onSalvar(); } catch (e) { aviso(e.message, true); ev.target.disabled = false; } } }, rotulo)
  ];
}

function abrirDestino(item, destino) {
  const citacao = el('div', { class: 'citacao', text: `${item.autor} · ${item.hora}\n${item.texto}` });
  const concluir = async (rotulo) => { fecharModal(); await marcarItem(item, 'usado', rotulo); aviso(`Enviado para ${rotulo} ✓`); };

  if (destino === 'ATIVIDADE') {
    const [c, t] = campoTexto('Texto na Seção 4 (ajuste se quiser)', item.texto, { autofocus: true });
    return abrirModal('📝 Nova atividade', [citacao, c], botoesSalvar(async () => {
      if (!t.value.trim()) throw new Error('Escreva a atividade.');
      await alterarFicha(f => f.atividades.push({ id: uid(), texto: t.value.trim() }));
      await concluir('Atividade');
    }));
  }
  if (destino === 'OCORRENCIA') {
    const [c, t] = campoTexto('Texto na Seção 7', `${item.hora} – ${item.texto}`, { autofocus: true });
    return abrirModal('🚨 Nova ocorrência', [citacao, c], botoesSalvar(async () => {
      if (!t.value.trim()) throw new Error('Descreva a ocorrência.');
      await alterarFicha(f => f.ocorrencias.push({ id: uid(), texto: t.value.trim() }));
      await concluir('Ocorrência');
    }));
  }
  if (destino === 'AVISO') {
    const [c1, ti] = campoLinha('Título (curto, em maiúsculas)', '', { placeholder: 'Ex.: BAGAGENS RETIDAS NA RFB – T-OIL', autofocus: true });
    const [c2, tx] = campoTexto('O que acompanhar', item.texto);
    return abrirModal('📌 Novo aviso de acompanhamento', [citacao, c1, c2], botoesSalvar(async () => {
      if (!ti.value.trim() && !tx.value.trim()) throw new Error('Preencha o aviso.');
      await alterarFicha(f => f.avisos.push({ id: uid(), titulo: ti.value.trim().toUpperCase(), texto: tx.value.trim() }));
      await concluir('Aviso');
    }));
  }
  if (destino === 'NAVIO') {
    const term = el('select', {}, el('option', { value: 'tore', text: 'T-ORE' }), el('option', { value: 'toil', text: 'T-OIL' }));
    term.value = item.campos?.terminal === 'T-OIL' ? 'toil' : 'tore';
    const montar = () => [(S.ficha.navios?.[term.value] || '').trim(), item.texto.trim()].filter(Boolean).join('\n');
    const [c, t] = campoTexto('Texto completo do terminal — edite a linha do navio se ele já estiver na lista', montar(), { linhas: 5 });
    term.addEventListener('change', () => { t.value = montar(); autoAltura(t); });
    return abrirModal('🚢 Movimentação de navios', [citacao, el('label', { class: 'campo' }, 'Terminal', term), c], botoesSalvar(async () => {
      await alterarFicha(f => { f.navios = f.navios || {}; f.navios[term.value] = t.value.trim(); });
      await concluir(`Navios ${term.value === 'tore' ? 'T-ORE' : 'T-OIL'}`);
    }, 'Salvar'));
  }
  if (destino === 'OPERACAO') {
    const cp = item.campos || {};
    const op = {
      tipo: tipoDoTexto(item.texto), navio: cp.navio, terminal: cp.terminal || '', quantidade: cp.quantidade,
      movimento: cp.movimento, placa: cp.placa, horaInicial: cp.hora || item.hora
    };
    return abrirFormOperacao(op, { item, citacao, concluir });
  }
  if (destino === 'SAIDA') {
    const abertas = operacoesAbertas();
    const sel = el('select', {}, abertas.map(o => el('option', { value: o.id, text: `${o.tipo} · ${o.navio || '—'}${o.placa ? ' · ' + o.placa : ''} (desde ${o.horaInicial || '?'})` })));
    const placa = (item.campos?.placa || '').replace('-', '');
    const casada = abertas.find(o => placa && (o.placa || '').replace('-', '') === placa);
    if (casada) sel.value = casada.id;
    const [c, h] = campoLinha('Horário de saída', item.campos?.hora || item.hora, { placeholder: 'HH:MM' });
    return abrirModal('🏁 Registrar saída', [citacao, el('label', { class: 'campo' }, 'Operação', sel), c,
      el('p', { class: 'mudo pequeno', text: 'Com o horário final, o e-mail da operação fica pronto no Relatório.' })],
    botoesSalvar(async () => {
      await alterarFicha(f => { const o = f.operacoes.find(x => x.id === sel.value); if (o) o.horaFinal = h.value.trim(); });
      await concluir('Saída registrada');
    }, 'Registrar'));
  }
}

// --------------------- Formulário de operação de bordo ---------------
function abrirFormOperacao(op = {}, ctx = {}) {
  const editando = !!op.id;
  const v = { ...op };
  const tipo = el('select', {}, TIPOS_OPERACAO.map(t => el('option', { value: t, text: t })));
  tipo.value = v.tipo || TIPOS_OPERACAO[0];
  const terminal = el('select', {}, ['', 'T-ORE', 'T-OIL'].map(t => el('option', { value: t, text: t || '—' })));
  terminal.value = v.terminal || '';
  const movimento = el('select', {}, ['', 'Embarque', 'Desembarque', 'Embarque e desembarque'].map(t => el('option', { value: t, text: t || '—' })));
  movimento.value = v.movimento || '';

  const L = (r, k, ph) => campoLinha(r, v[k], { placeholder: ph });
  const [cNavio, iNavio] = L('Navio', 'navio', 'Ex.: LILA PSARA');
  const [cEmp, iEmp] = L('Empresa / agência / fornecedor', 'empresa');
  const [cResp, iResp] = L('Agente / motorista responsável', 'responsavel');
  const [cVei, iVei] = L('Veículo', 'veiculo', 'Ex.: Van, Caminhão baú');
  const [cPla, iPla] = L('Placa', 'placa', 'ABC-1D23');
  const [cQtd, iQtd] = L('Quantos tripulantes', 'quantidade', '03');
  const [cHi, iHi] = L('Horário inicial', 'horaInicial', 'HH:MM');
  const [cHf, iHf] = L('Horário final', 'horaFinal', 'vazio = em andamento');
  const [cAut, iAut] = L('Autorizado por (Autoridades)', 'autoridades', 'S/A');
  const [cTer, iTer] = L('Autorizados por (Terminal)', 'autorizadoTerminal', 'S/A');
  const [cObs, iObs] = campoTexto('Observações', v.observacoes, { linhas: 2, placeholder: 'S/A' });

  const tripulacao = el('div', { class: 'grade-2' }, cQtd, el('label', { class: 'campo' }, 'Embarque ou desembarque', movimento));
  const mostrarTrip = () => { tripulacao.hidden = tipo.value !== TIPOS_OPERACAO[0]; };
  tipo.addEventListener('change', mostrarTrip); mostrarTrip();

  let chkAtiv = null, txtAtiv = null;
  const extras = [];
  if (ctx.item) {
    chkAtiv = el('input', { type: 'checkbox', checked: true });
    [, txtAtiv] = campoTexto('', ctx.item.texto, { linhas: 2 });
    extras.push(el('label', { class: 'check' }, chkAtiv, 'Registrar também nas Atividades (Seção 4)'), txtAtiv);
    chkAtiv.addEventListener('change', () => { txtAtiv.hidden = !chkAtiv.checked; });
  }

  abrirModal(editando ? 'Editar operação de bordo' : '✉️ Operação de bordo', [
    ctx.citacao || null,
    el('label', { class: 'campo' }, 'Tipo', tipo),
    el('div', { class: 'grade-2' }, cNavio, el('label', { class: 'campo' }, 'Terminal', terminal)),
    tripulacao,
    el('div', { class: 'grade-2' }, cHi, cHf),
    cEmp, cResp,
    el('div', { class: 'grade-2' }, cVei, cPla),
    el('div', { class: 'grade-2' }, cAut, cTer),
    cObs, ...extras
  ], botoesSalvar(async () => {
    const dados = {
      tipo: tipo.value, navio: iNavio.value.trim().toUpperCase(), terminal: terminal.value,
      quantidade: iQtd.value.trim(), movimento: movimento.value, empresa: iEmp.value.trim(),
      responsavel: iResp.value.trim(), veiculo: iVei.value.trim(), placa: iPla.value.trim().toUpperCase(),
      horaInicial: iHi.value.trim(), horaFinal: iHf.value.trim(), autoridades: iAut.value.trim(),
      autorizadoTerminal: iTer.value.trim(), observacoes: iObs.value.trim()
    };
    await alterarFicha(f => {
      f.operacoes = f.operacoes || [];
      if (editando) Object.assign(f.operacoes.find(o => o.id === op.id) || {}, dados);
      else f.operacoes.push({ id: uid(), criadoEm: new Date().toISOString(), ...dados });
      if (chkAtiv?.checked && txtAtiv.value.trim()) f.atividades.push({ id: uid(), texto: txtAtiv.value.trim() });
    });
    if (ctx.concluir) await ctx.concluir('Operação de bordo');
    else { fecharModal(); aviso('Operação salva ✓'); }
  }, editando ? 'Salvar' : 'Adicionar'));
}

// =====================================================================
// ABA 3 · RELATÓRIO (as 8 seções, tudo editável)
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
  return el('label', { class: 'campo' }, rotulo, entrada);
}

function secao(num, titulo, ...conteudo) {
  return el('section', { class: 'cartao' },
    el('h2', {}, num ? el('span', { class: 'secao-num', text: num }) : null, titulo), ...conteudo);
}

function editorLista(chave, { vazio, placeholder, rotuloNovo }) {
  const box = el('div', { class: 'lista' });
  const desenhar = (focarUltimo) => {
    const arr = S.ficha[chave] = S.ficha[chave] || [];
    box.replaceChildren();
    if (!arr.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: vazio }));
    arr.forEach((it, i) => {
      const t = el('textarea', { rows: 1, value: it.texto, placeholder, oninput: e => { it.texto = e.target.value; autoAltura(e.target); agendarSalvar(); } });
      const mover = d => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; desenhar(); agendarSalvar(); };
      box.append(el('div', { class: 'item-lista' }, t, el('div', { class: 'ferramentas' },
        el('button', { title: 'Subir', 'aria-label': 'Subir', onclick: () => mover(-1) }, '↑'),
        el('button', { title: 'Descer', 'aria-label': 'Descer', onclick: () => mover(1) }, '↓'),
        el('button', { title: 'Remover', 'aria-label': 'Remover', onclick: () => { arr.splice(i, 1); desenhar(); agendarSalvar(); } }, '✕')
      )));
    });
    requestAnimationFrame(() => {
      box.querySelectorAll('textarea').forEach(autoAltura);
      if (focarUltimo) { const ts = box.querySelectorAll('textarea'); ts[ts.length - 1]?.focus(); }
    });
  };
  desenhar();
  return el('div', { class: 'lista' }, box,
    el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { S.ficha[chave].push({ id: uid(), texto: '' }); desenhar(true); } }, '+ ' + rotuloNovo)));
}

function editorAvisos() {
  const box = el('div', { class: 'lista' });
  const desenhar = (focar) => {
    const arr = S.ficha.avisos = S.ficha.avisos || [];
    box.replaceChildren();
    if (!arr.length) box.append(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhum aviso em aberto (sai "✓ S/A").' }));
    arr.forEach((av, i) => {
      const ti = el('input', { type: 'text', value: av.titulo || '', placeholder: 'TÍTULO DO AVISO', oninput: e => { av.titulo = e.target.value; agendarSalvar(); } });
      const tx = el('textarea', { rows: 2, value: av.texto || '', placeholder: 'O que acompanhar', oninput: e => { av.texto = e.target.value; autoAltura(e.target); agendarSalvar(); } });
      box.append(el('div', { class: 'aviso-item' },
        el('div', { class: 'linha', style: 'flex-wrap:nowrap' }, el('span', { class: 'mudo pequeno', text: `5.${i + 1}` }), ti),
        tx,
        el('div', { class: 'linha', style: 'justify-content:flex-end' },
          el('button', { class: 'btn fantasma pequeno', onclick: async () => {
            if (await confirmar('Dar baixa no aviso?', `"${av.titulo || av.texto}" sai do relatório.`, 'Dar baixa')) { arr.splice(i, 1); desenhar(); agendarSalvar(); }
          } }, '✓ Dar baixa'))
      ));
    });
    requestAnimationFrame(() => {
      box.querySelectorAll('textarea').forEach(autoAltura);
      if (focar) { const ins = box.querySelectorAll('input'); ins[ins.length - 1]?.focus(); }
    });
  };
  desenhar();
  return el('div', { class: 'lista' }, box,
    el('div', {}, el('button', { class: 'btn pequeno', onclick: () => { S.ficha.avisos.push({ id: uid(), titulo: '', texto: '' }); desenhar(true); } }, '+ Novo aviso')));
}

function listaOperacoes() {
  const ops = S.ficha.operacoes || [];
  if (!ops.length) return el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Nenhuma operação no turno. Elas entram pela Entrada (botão "Operação de bordo") ou aqui.' });
  return el('div', { class: 'lista' }, ops.map(o => el('div', { class: 'op' },
    el('div', { class: 'cartao-topo' },
      el('div', {}, el('strong', { text: `${o.tipo}` }), el('div', { class: 'mudo pequeno', text: `${o.navio || 'Navio?'}${o.terminal ? ' · ' + o.terminal : ''}${o.placa ? ' · ' + o.placa : ''}` })),
      el('span', { class: `etiqueta ${o.horaFinal ? 'ok' : 'atencao'}`, text: o.horaFinal ? (o.emailAbertoEm ? 'E-mail aberto' : 'Pronta p/ e-mail') : 'Em andamento' })
    ),
    el('div', { class: 'pequeno mudo', text: `Início ${o.horaInicial || '—'} · Fim ${o.horaFinal || 'aguardando saída'}${o.empresa ? ' · ' + o.empresa : ''}` }),
    el('div', { class: 'linha', style: 'justify-content:flex-end' },
      el('button', { class: 'btn fantasma pequeno', onclick: async () => {
        if (await confirmar('Remover operação?', `${o.tipo} · ${o.navio || ''}`, 'Remover', true)) await alterarFicha(f => { f.operacoes = f.operacoes.filter(x => x.id !== o.id); });
      } }, 'Remover'),
      el('button', { class: 'btn pequeno', onclick: () => abrirFormOperacao(o) }, 'Editar'),
      o.horaFinal
        ? el('button', { class: 'btn primario pequeno', onclick: () => abrirEmail(o) }, '✉️ E-mail')
        : el('button', { class: 'btn verde pequeno', onclick: () => registrarSaida(o) }, '🏁 Registrar saída')
    )
  )));
}

function registrarSaida(o) {
  const [c, h] = campoLinha('Horário de saída', agoraBR().hora, { autofocus: true });
  abrirModal('🏁 Registrar saída', [el('div', { class: 'citacao', text: `${o.tipo} · ${o.navio || ''}` }), c], botoesSalvar(async () => {
    await alterarFicha(f => { const x = f.operacoes.find(y => y.id === o.id); if (x) x.horaFinal = h.value.trim(); });
    fecharModal(); aviso('Saída registrada ✓');
  }, 'Registrar'));
}

async function abrirEmail(o) {
  try {
    await salvarAgora();
    const m = await api('GET', `/api/email/${encodeURIComponent(o.id)}`);
    const [cPara, iPara] = campoLinha('Para', m.para, { placeholder: 'Defina os destinatários em Configurações' });
    const [cCc, iCc] = campoLinha('Cópia (Cc)', m.cc);
    const [cAss, iAss] = campoLinha('Assunto', m.assunto);
    const [cCorpo, tCorpo] = campoTexto('Mensagem', m.corpo, { linhas: 14 });
    const marcar = () => alterarFicha(f => { const x = f.operacoes.find(y => y.id === o.id); if (x) x.emailAbertoEm = new Date().toISOString(); });
    const q = (k, v) => v ? `${k}=${encodeURIComponent(v)}` : '';
    abrirModal('✉️ E-mail da operação', [cPara, cCc, cAss, cCorpo,
      el('p', { class: 'mudo pequeno', text: 'Revise e anexe as evidências no Outlook antes de enviar.' })], [
      el('button', { class: 'btn', onclick: () => copiar(`Assunto: ${iAss.value}\n\n${tCorpo.value}`) }, '📋 Copiar'),
      el('button', { class: 'btn', onclick: () => { marcar(); window.open(`https://outlook.office.com/mail/deeplink/compose?${[q('to', iPara.value), q('cc', iCc.value), q('subject', iAss.value), q('body', tCorpo.value)].filter(Boolean).join('&')}`, '_blank', 'noopener'); } }, '🌐 Outlook Web'),
      el('button', { class: 'btn primario', onclick: () => { marcar(); location.href = `mailto:${encodeURIComponent(iPara.value).replace(/%40/g, '@').replace(/%2C/g, ',').replace(/%3B/g, ';')}?${[q('cc', iCc.value), q('subject', iAss.value), q('body', tCorpo.value)].filter(Boolean).join('&')}`; } }, '📧 App de e-mail')
    ]);
  } catch (e) { aviso(e.message, true); }
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

function desenharRelatorio() {
  const c = $('#aba-relatorio');
  const turno = el('select', { onchange: e => { S.ficha.turno = e.target.value; agendarSalvar(); } },
    el('option', { value: 'DIURNO', text: 'DIURNO' }), el('option', { value: 'NOTURNO', text: 'NOTURNO' }));
  turno.value = S.ficha.turno;

  c.replaceChildren(
    el('section', { class: 'cartao' },
      el('div', { class: 'grade-2' }, el('label', { class: 'campo' }, 'Turno', turno), campo('Data', 'data', { placeholder: 'DD/MM/AAAA' })),
      el('div', { id: 'bloco-conferencia', class: 'alertas' })
    ),
    secao('1', 'Efetivo CCOS', campo('', 'efetivo', { multilinha: true, placeholder: '✓ S/A' })),
    secao('2', 'Viatura – VTR',
      el('div', { class: 'grade-2' }, campo('Veículo', 'vtr.modelo'), campo('Placa', 'vtr.placa')),
      el('div', { class: 'grade-2' }, campo('KM inicial', 'vtr.kmInicial', { tipo: 'number' }), campo('KM final', 'vtr.kmFinal', { tipo: 'number' })),
      el('div', { id: 'km-rodados', class: 'mudo pequeno' })
    ),
    secao('3', 'Sistemas',
      campo('CFTV', 'sistemas.cftv', { multilinha: true, placeholder: '✓ S/A' }),
      campo('CA – Controle de acesso', 'sistemas.ca', { multilinha: true, linhas: 1, placeholder: '✓ S/A' }),
      el('div', { class: 'grade-2' }, campo('OCR – Assertividade', 'sistemas.ocrAssertividade', { placeholder: '88,05%' }), campo('OCR – Total de leituras', 'sistemas.ocrLeituras', { tipo: 'number', placeholder: '188' }))
    ),
    secao('4', 'Atividades realizadas', editorLista('atividades', { vazio: 'Nenhuma atividade.', placeholder: 'Descreva a atividade', rotuloNovo: 'Nova atividade' })),
    secao('5', 'Avisos e ações de acompanhamento', editorAvisos()),
    secao('6', 'Movimentação de navios',
      campo('T-ORE', 'navios.tore', { multilinha: true, linhas: 2, placeholder: 'NAVIO: situação' }),
      campo('T-OIL', 'navios.toil', { multilinha: true, linhas: 2, placeholder: 'NAVIO: situação' })
    ),
    secao('7', 'Ocorrências', editorLista('ocorrencias', { vazio: 'Sem ocorrências (sai "✓ S/A").', placeholder: 'Descreva a ocorrência', rotuloNovo: 'Nova ocorrência' })),
    secao('8', 'Passagem de turno',
      campo('Equipe saindo', 'equipes.saindo', { placeholder: 'Ex.: Ruddgero Ribeiro e Equipe CCOS' }),
      campo('Equipe assumindo', 'equipes.assumindo', { placeholder: 'Ex.: Wallace Ferroport e Equipe US' })
    ),
    secao('', '✉️ Operações de bordo (e-mails)',
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Não entram no texto do relatório; geram o e-mail de cada operação depois da saída do veículo.' }),
      el('div', { id: 'lista-operacoes' }, listaOperacoes()),
      el('div', {}, el('button', { class: 'btn pequeno', onclick: () => abrirFormOperacao({ horaInicial: agoraBR().hora }) }, '+ Nova operação'))
    ),
    el('div', { class: 'barra-acoes' },
      el('span', { id: 'estado-salvo', class: 'estado-salvo', text: S.sujo ? 'Salvando…' : 'Salvo ✓' }),
      el('button', { class: 'btn', onclick: abrirPrevia }, '👁 Prévia'),
      el('button', { class: 'btn primario', onclick: publicar }, '🚀 Publicar')
    )
  );
  desenharConferencia();
  atualizarKmRodados();
  requestAnimationFrame(() => c.querySelectorAll('textarea').forEach(autoAltura));
}

// --------------------------- Destinos finais ------------------------
async function textoAtual() {
  await salvarAgora();
  return api('GET', '/api/ficha/texto');
}

async function abrirPrevia() {
  try {
    const t = await textoAtual();
    const f = S.ficha;
    const nome = `Relatorio_Turno_${f.turno}_${f.data.replace(/\//g, '-')}.txt`;
    abrirModal('Prévia do relatório', [
      t.conferencia.length ? el('div', { class: 'alertas' }, t.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
      el('div', { class: 'previa' }, textoWhats(t.whatsapp))
    ], [
      el('button', { class: 'btn', onclick: () => copiar(t.whatsapp) }, '📋 Copiar'),
      el('button', { class: 'btn', onclick: () => baixar(nome, t.simples) }, '💾 .txt'),
      el('button', { class: 'btn', onclick: () => imprimir(t.simples) }, '📄 PDF'),
      el('button', { class: 'btn primario', onclick: () => { fecharModal(); publicar(); } }, '🚀 Publicar')
    ]);
  } catch (e) { aviso(e.message, true); }
}

function imprimir(textoSimples) {
  const f = S.ficha;
  $('#impressao').replaceChildren(
    el('div', { class: 'cab' },
      el('strong', { text: 'FERROPORT · PORTO DO AÇU' }), el('br'),
      el('span', { text: `CCOS — Relatório do Turno ${f.turno} · ${f.data} · emitido em ${agoraBR().data} ${agoraBR().hora}` })),
    el('pre', { text: textoSimples }),
    el('div', { class: 'assinaturas' }, el('div', { text: `Equipe saindo: ${f.equipes?.saindo || ''}` }), el('div', { text: `Equipe assumindo: ${f.equipes?.assumindo || ''}` }))
  );
  window.print();
}

async function publicar() {
  try {
    const t = await textoAtual();
    const cfg = S.config;
    const conectado = S.estado?.whatsapp?.estado === 'CONECTADO';
    const nomeGrupo = cfg.nomesGrupos?.[cfg.grupoPublicacao] || '';
    if (!conectado || !cfg.grupoPublicacao) {
      return abrirModal('Não dá para publicar agora', [
        el('p', { text: !conectado ? 'O WhatsApp do robô não está conectado.' : 'Nenhum grupo de publicação escolhido em Configurações.' }),
        el('p', { class: 'mudo', text: 'Você pode copiar o texto e colar no grupo manualmente.' })
      ], [
        el('button', { class: 'btn', onclick: () => { fecharModal(); abrirConfig(); } }, 'Configurações'),
        el('button', { class: 'btn primario', onclick: () => { copiar(t.whatsapp); fecharModal(); } }, '📋 Copiar texto')
      ]);
    }
    const anexo = el('input', { type: 'checkbox' });
    const ok = await confirmar('Publicar no grupo?', [
      el('p', {}, 'O relatório será enviado para ', el('strong', { text: nomeGrupo || 'o grupo escolhido' }), ' exatamente como na prévia.'),
      t.conferencia.length ? el('div', { class: 'alertas' }, el('strong', { text: 'Antes de publicar, confira:' }), t.conferencia.map(a => el('div', { text: '• ' + a }))) : null,
      el('label', { class: 'check' }, anexo, 'Anexar também o arquivo .txt')
    ], 'Publicar agora');
    if (!ok) return;
    const r = await api('POST', '/api/ficha/publicar', { anexarTxt: anexo.checked });
    S.ficha.publicadoEm = r.publicadoEm;
    aviso('Relatório publicado no grupo ✓');
  } catch (e) { aviso(e.message, true); }
}

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
let timerWhats = null;
let assinaturaWhats = '';
let gruposCarregados = null;

async function abrirConfig() {
  const p = $('#painel-config');
  p.hidden = false;
  document.body.style.overflow = 'hidden';
  S.config = (await api('GET', '/api/config')).config;
  desenharConfig();
  assinaturaWhats = '';
  await atualizarWhats();
  clearInterval(timerWhats);
  timerWhats = setInterval(atualizarWhats, 4000);
}

function fecharConfig() {
  $('#painel-config').hidden = true;
  document.body.style.overflow = '';
  clearInterval(timerWhats);
  atualizarEstado();
}

function desenharConfig() {
  const cfg = S.config;
  const L = (rotulo, chave, opts = {}) => {
    const i = el('input', { type: opts.tipo || 'text', value: cfg[chave] ?? '', placeholder: opts.placeholder, oninput: e => { cfg[chave] = e.target.value; } });
    return el('label', { class: 'campo' }, rotulo, i);
  };
  const alertasChk = el('input', { type: 'checkbox', checked: cfg.alertasAtivos, onchange: e => { cfg.alertasAtivos = e.target.checked; } });
  const base = el('textarea', { rows: 3, value: (cfg.atividadesBase || []).join('\n'), oninput: e => { cfg.atividadesBase = e.target.value.split('\n'); autoAltura(e.target); } });

  $('#painel-config').replaceChildren(el('div', { class: 'painel-conteudo' },
    el('div', { class: 'painel-topo' },
      el('button', { class: 'btn-icone', 'aria-label': 'Voltar', onclick: fecharConfig }, '←'),
      el('h1', { text: 'Configurações' })
    ),
    el('section', { class: 'cartao', id: 'cfg-whats' }, el('h2', { text: 'WhatsApp' }), el('p', { class: 'mudo', text: 'Carregando…' })),
    el('section', { class: 'cartao', id: 'cfg-grupos' }),
    el('section', { class: 'cartao' },
      el('h2', { text: 'Alerta de emergência' }),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Mensagens com palavras como incêndio, acidente, ferido, vazamento geram um aviso no privado deste número.' }),
      el('label', { class: 'check' }, alertasChk, 'Enviar alerta no privado'),
      L('Número que recebe (55 + DDD + número)', 'alertaNumero', { tipo: 'tel', placeholder: '5522998765432' })
    ),
    el('section', { class: 'cartao' },
      el('h2', { text: 'E-mails de bordo' }),
      L('Destinatários (separe por ;)', 'emailDestinatarios', { placeholder: 'operacoes@empresa.com.br; supervisao@empresa.com.br' }),
      L('Cópia (Cc)', 'emailCopia')
    ),
    el('section', { class: 'cartao' },
      el('h2', { text: 'Padrões do relatório' }),
      el('div', { class: 'grade-2' }, L('Viatura', 'vtrModelo'), L('Placa da viatura', 'vtrPlaca')),
      el('label', { class: 'campo' }, 'Atividades fixas de todo turno (uma por linha)', base)
    ),
    el('div', {}, el('button', { class: 'btn primario largo', onclick: salvarConfig }, 'Salvar configurações')),
    el('section', { class: 'cartao' },
      el('h2', { text: 'Turnos anteriores' }),
      el('div', { id: 'cfg-historico' }, el('button', { class: 'btn pequeno', onclick: carregarHistorico }, 'Ver histórico'))
    ),
    el('section', { class: 'cartao' },
      el('div', { class: 'linha', style: 'justify-content:space-between' },
        el('span', { class: 'mudo pequeno', text: `Dados guardados em: ${S.estado?.armazenamento === 'firestore' ? 'Firebase' : 'pasta "dados" do computador'}` }),
        el('button', { class: 'btn perigo pequeno', onclick: async () => { await api('POST', '/api/logout'); fecharConfig(); mostrarLogin(); } }, 'Sair')
      )
    )
  ));
  desenharGrupos();
  requestAnimationFrame(() => autoAltura(base));
}

async function salvarConfig() {
  try {
    S.config = (await api('PUT', '/api/config', { config: S.config })).config;
    aviso('Configurações salvas ✓');
  } catch (e) { aviso(e.message, true); }
}

async function atualizarWhats() {
  try {
    const w = await api('GET', '/api/whatsapp');
    const assinatura = `${w.estado}|${w.qrSvg ? w.qrSvg.length : 0}|${w.numero}|${w.erro}`;
    if (assinatura === assinaturaWhats) return;
    const mudouConexao = assinaturaWhats.split('|')[0] !== w.estado;
    assinaturaWhats = assinatura;
    desenharWhats(w);
    if (mudouConexao) desenharGrupos();
  } catch (_) {}
}

function desenharWhats(w) {
  const box = $('#cfg-whats'); if (!box) return;
  const filhos = [el('h2', { text: 'WhatsApp' })];
  S.whats = w;
  if (w.estado === 'CONECTADO') {
    filhos.push(
      el('div', { class: 'linha' }, el('span', { class: 'etiqueta ok', text: '● Conectado' }), el('span', { class: 'mudo', text: w.numero ? `+${w.numero}` : '' })),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'O robô só lê os grupos marcados abaixo e nunca escreve neles sozinho.' }),
      el('div', {}, el('button', { class: 'btn perigo pequeno', onclick: async () => {
        if (await confirmar('Desconectar o aparelho?', 'O robô para de ler o WhatsApp até você conectar de novo.', 'Desconectar', true)) {
          await api('POST', '/api/whatsapp/desconectar'); assinaturaWhats = ''; atualizarWhats();
        }
      } }, 'Desconectar aparelho'))
    );
  } else if (w.estado === 'AGUARDANDO_PAREAMENTO') {
    const tel = el('input', { type: 'tel', placeholder: '5522998765432' });
    const saida = el('div');
    filhos.push(
      el('span', { class: 'etiqueta atencao', text: 'Aguardando conexão' }),
      el('ol', { style: 'margin:0;padding-left:20px', class: 'pequeno' },
        el('li', { text: 'No celular do robô, abra o WhatsApp > Aparelhos conectados > Conectar um aparelho.' }),
        el('li', { text: 'Aponte a câmera para o QR abaixo.' })),
      w.qrSvg ? Object.assign(el('div', { class: 'qr' }), { innerHTML: w.qrSvg }) : el('p', { class: 'mudo pequeno', text: 'QR indisponível — use o código por número abaixo.' }),
      el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Sem câmera? Gere um código e digite no celular em "Conectar com número de telefone":' }),
      el('div', { class: 'linha', style: 'flex-wrap:nowrap' }, tel, el('button', { class: 'btn', onclick: async () => {
        try { const r = await api('POST', '/api/whatsapp/codigo', { numero: tel.value }); saida.replaceChildren(el('div', { class: 'codigo-pareamento', text: r.codigo })); }
        catch (e) { aviso(e.message, true); }
      } }, 'Gerar código')),
      saida
    );
  } else {
    const rot = { CONECTANDO: 'Conectando…', RECONECTANDO: 'Reconectando…', INDISPONIVEL: 'Indisponível', DESCONECTADO: 'Desconectado', ERRO: 'Erro', DESLIGADO: 'Desligado' };
    filhos.push(el('span', { class: 'etiqueta atencao', text: rot[w.estado] || w.estado }));
    if (w.erro) filhos.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: w.erro }));
  }
  box.replaceChildren(...filhos);
}

function desenharGrupos() {
  const box = $('#cfg-grupos'); if (!box) return;
  const cfg = S.config;
  const conectado = S.whats?.estado === 'CONECTADO';
  const atuais = (cfg.gruposMonitorados || []).map(id => cfg.nomesGrupos?.[id] || id);
  const filhos = [
    el('h2', { text: 'Grupos' }),
    el('div', { class: 'pequeno' },
      el('div', {}, el('span', { class: 'mudo', text: 'Lendo: ' }), atuais.length ? atuais.join(', ') : 'nenhum grupo'),
      el('div', {}, el('span', { class: 'mudo', text: 'Publica em: ' }), cfg.nomesGrupos?.[cfg.grupoPublicacao] || '—'))
  ];
  if (!conectado) {
    filhos.push(el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Conecte o WhatsApp para escolher os grupos.' }));
    box.replaceChildren(...filhos); return;
  }
  if (!gruposCarregados) {
    filhos.push(el('div', {}, el('button', { class: 'btn', onclick: async ev => {
      ev.target.disabled = true;
      try { gruposCarregados = (await api('GET', '/api/whatsapp/grupos')).grupos; desenharGrupos(); }
      catch (e) { aviso(e.message, true); ev.target.disabled = false; }
    } }, 'Escolher grupos')));
    box.replaceChildren(...filhos); return;
  }
  const marcados = new Set(cfg.gruposMonitorados || []);
  const busca = el('input', { type: 'search', placeholder: 'Filtrar grupos…' });
  const lista = el('div', { class: 'lista-grupos' });
  const pub = el('select', {}, el('option', { value: '', text: '— escolha —' }), gruposCarregados.map(g => el('option', { value: g.id, text: g.nome })));
  pub.value = cfg.grupoPublicacao || '';
  const desenharLista = () => {
    const t = semAcento(busca.value).toLowerCase();
    lista.replaceChildren(...gruposCarregados.filter(g => !t || semAcento(g.nome).toLowerCase().includes(t)).map(g => {
      const c = el('input', { type: 'checkbox', checked: marcados.has(g.id), onchange: e => { e.target.checked ? marcados.add(g.id) : marcados.delete(g.id); } });
      return el('label', { class: 'check' }, c, el('span', {}, g.nome, el('span', { class: 'mudo pequeno', text: `  ${g.membros} membros` })));
    }));
  };
  busca.addEventListener('input', desenharLista);
  desenharLista();
  filhos.push(
    el('p', { class: 'mudo pequeno', style: 'margin:0', text: 'Marque só os grupos de trabalho (ex.: EQUIPE AZUL - US FERROPORT). Os outros grupos nunca são lidos.' }),
    busca, lista,
    el('label', { class: 'campo' }, 'Publicar o relatório em', pub),
    el('div', {}, el('button', { class: 'btn primario', onclick: async () => {
      const nomes = {};
      gruposCarregados.forEach(g => { if (marcados.has(g.id) || g.id === pub.value) nomes[g.id] = g.nome; });
      cfg.gruposMonitorados = [...marcados];
      cfg.grupoPublicacao = pub.value;
      cfg.nomesGrupos = nomes;
      await salvarConfig();
      gruposCarregados = null; desenharGrupos();
    } }, 'Salvar grupos'))
  );
  box.replaceChildren(...filhos);
}

async function carregarHistorico() {
  const box = $('#cfg-historico');
  try {
    const { itens } = await api('GET', '/api/historico');
    box.replaceChildren(...(itens.length ? itens.map(h => el('details', { class: 'historico' },
      el('summary', { text: `${h.data} · ${h.turno}${h.publicadoEm ? ' · publicado' : ''}` }),
      el('div', { class: 'texto-bruto', style: 'margin:8px 0', text: h.texto }),
      el('button', { class: 'btn pequeno', onclick: () => copiar(h.texto) }, 'Copiar')
    )) : [el('p', { class: 'mudo pequeno', text: 'Nenhum turno arquivado ainda.' })]));
  } catch (e) { aviso(e.message, true); }
}

// ------------------------------ Início ------------------------------
(async function iniciar() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const s = await api('GET', '/api/sessao');
    if (s.logado) entrar(); else mostrarLogin();
  } catch (_) { mostrarLogin(); }
})();

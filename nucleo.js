// =====================================================================
// NÚCLEO: estado do sistema e regras de negócio
//  plantão · ficha do turno · relatórios (últimos 10 para herança + histórico completo)
//  caixa de entrada · operações de bordo + e-mail · pendências · escala
// =====================================================================
const store = require('./store');
const R = require('./relatorio');
const usuarios = require('./usuarios');
const email = require('./email');
const { agora, novoId, semAcento, chaveTurno, normalizarHora, normalizarPlaca, lerPlacas, placasEmComum, normalizarTerminal, limparMarcador } = require('./util');

const LIMITE_ENTRADA = 400;
const LIMITE_RELATORIOS = 10;
const DOZE_HORAS = 12 * 3600 * 1000;

const CONFIG_PADRAO = {
    grupoPublicacao: '',
    nomesGrupos: {},
    alertaNumero: '',
    alertasAtivos: true,
    emailDestinatarios: '',
    emailCopia: '',
    emailPadrao: '',
    emailDiretoOficial: false,      // true = envia direto para a lista oficial (cópia para o líder)
    minutaNoWhatsapp: true,         // se o e-mail não puder sair, manda a minuta no WhatsApp do líder
    vtrModelo: 'L200',
    vtrPlaca: 'TDG-8C89',
    atividadesBase: [
        'Realizadas atividades administrativas.',
        'Executada ronda em todo o terminal, com apoio do Supervisor Sunset.'
    ],
    navios: R.NAVIOS_PADRAO,
    ultimoTextoPublicado: ''
};

const estado = {
    config: null, ficha: null, versao: 0,
    entrada: [], relatorios: [], operacoes: [], pendencias: [],
    escala: null, plantao: {}, auditoria: [], equipes: [], historico: []
};

const handlers = { alerta: null, plantaoMudou: null, minutaWhatsapp: null };
const timers = {};

function erro(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function quem(u) { return u ? { id: u.id, nome: u.nome } : { id: 'robo', nome: 'Robô' }; }

function salvarDepois(chave, valor, ms = 1200) {
    clearTimeout(timers[chave]);
    timers[chave] = setTimeout(() => store.set(chave, valor()).catch(e => console.error(`Erro ao salvar ${chave}:`, e.message)), ms);
}

// =====================================================================
// Carga inicial (com migração dos dados da versão anterior)
// =====================================================================
async function carregar() {
    const cfg = await store.get('config', null);
    estado.config = { ...CONFIG_PADRAO, ...(cfg || {}) };
    if (!Array.isArray(estado.config.navios) || !estado.config.navios.length) estado.config.navios = R.NAVIOS_PADRAO;
    if (!cfg) {
        if (process.env.WHATSAPP_NUMERO_ALERTA) estado.config.alertaNumero = process.env.WHATSAPP_NUMERO_ALERTA.replace(/\D/g, '');
        if (process.env.EMAIL_DESTINATARIOS) estado.config.emailDestinatarios = process.env.EMAIL_DESTINATARIOS;
    }

    estado.entrada = await store.get('entrada', []) || [];
    estado.operacoes = await store.get('operacoes', []) || [];
    estado.pendencias = await store.get('pendencias', []) || [];
    estado.escala = await store.get('escala', null);
    estado.plantao = await store.get('plantao', {}) || {};
    estado.auditoria = await store.get('auditoria', []) || [];
    estado.equipes = await store.get('equipes', []) || [];
    estado.historico = await store.listarRelatorios();
    await deduplicarHistorico();
    estado.relatorios = await store.get('relatorios_us', null);

    let ficha = await store.get('ficha', null);
    let migrou = false;

    // --- Migração da versão 3 ---
    if (!estado.relatorios) {
        const antigo = await store.get('relatorio_us', null);
        estado.relatorios = antigo ? [{ id: novoId(), ...antigo, assinatura: assinatura(antigo.texto) }] : [];
        await store.set('relatorios_us', estado.relatorios);
        if (antigo) migrou = true;
    }
    if (ficha) {
        if (!ficha.anterior && ficha.herdadoDe?.relatorioId) {
            const rel = estado.relatorios.find(r => r.id === ficha.herdadoDe.relatorioId);
            if (rel) ficha.anterior = { assumindo: rel.dados?.equipes?.assumindo || '', kmFinal: rel.dados?.vtr?.kmFinal ?? null, turno: rel.dados?.turno || '', data: rel.dados?.data || '' };
        }
        if (ficha.equipes && !ficha.equipes.modo) {
            const sai = (ficha.equipes.saindo || '').trim(), ass = (ficha.equipes.assumindo || '').trim();
            ficha.equipes = { modo: /conforme/i.test(sai + ass) || (!sai && !ass) ? 'ESCALA' : 'NOMES', saindo: sai, assumindo: ass, saindoLista: R.separarNomes(sai), assumindoLista: R.separarNomes(ass) };
        }
        if (Array.isArray(ficha.avisos)) {
            for (const av of ficha.avisos) {
                if (!(av.titulo || av.texto)) continue;
                estado.pendencias.push(novaPendencia({ tipo: 'AVISO', titulo: av.titulo || 'AVISO', texto: av.texto || '' }, null, 'Migrado da versão anterior', ficha));
            }
            delete ficha.avisos; migrou = true;
        }
        if (ficha.navios && (typeof ficha.navios.tore === 'string' || typeof ficha.navios.toil === 'string')) {
            ficha.navios = { tore: R.naviosDeTexto(ficha.navios.tore), toil: R.naviosDeTexto(ficha.navios.toil) };
            migrou = true;
        }
        if (Array.isArray(ficha.operacoes)) {
            for (const o of ficha.operacoes) {
                estado.operacoes.push({ ...o, tipo: R.tipoOperacaoDoTexto(o.tipo || ''), fichaId: ficha.id, email: {} });
            }
            delete ficha.operacoes; migrou = true;
        }
        ficha.navios = ficha.navios || { tore: [], toil: [] };
        if (ficha.herdadoDe && !ficha.herdadoDe.encontrados) ficha.herdadoDe.encontrados = [];
    }
    // grupos escolhidos na versão anterior passam a ser os grupos do administrador
    if (Array.isArray(cfg?.gruposMonitorados) && cfg.gruposMonitorados.length) {
        const adm = usuarios.admin();
        if (adm && !adm.whatsapp.grupos.length) await usuarios.atualizarWhatsapp(adm.id, { grupos: cfg.gruposMonitorados });
        delete estado.config.gruposMonitorados;
        migrou = true;
    }
    estado.ficha = ficha || R.fichaVazia(estado.config);
    estado.versao = estado.ficha.versao || 0;
    for (const r of [...(estado.relatorios || [])].reverse()) {
        await arquivarRelatorio({ texto: r.texto, autor: r.autor, origem: r.manual ? 'colado' : 'grupo', grupoNome: r.grupoNome, mensagemTs: r.mensagemTs, silencioso: true });
    }

    if (migrou || !cfg) {
        await Promise.all([
            store.set('config', estado.config), store.set('ficha', estado.ficha), store.set('pendencias', estado.pendencias),
            store.set('operacoes', estado.operacoes), store.set('relatorios_us', estado.relatorios)
        ]);
        if (migrou) console.log('🔄 [MIGRAÇÃO] Dados da versão anterior convertidos (avisos → pendências, navios e operações).');
    }
}

function aoAlerta(fn) { handlers.alerta = fn; }
function aoMudarPlantao(fn) { handlers.plantaoMudou = fn; }
function aoPrecisarMinutaWhatsapp(fn) { handlers.minutaWhatsapp = fn; }

// =====================================================================
// Auditoria
// =====================================================================
function auditar(usuario, acao, detalhe = '') {
    const t = agora();
    estado.auditoria.push({ em: t.iso, data: t.data, hora: t.hora, por: usuario ? usuario.nome : 'Robô', acao, detalhe: String(detalhe).slice(0, 200) });
    if (estado.auditoria.length > 500) estado.auditoria = estado.auditoria.slice(-500);
    salvarDepois('auditoria', () => estado.auditoria, 3000);
}

// =====================================================================
// Configuração
// =====================================================================
async function salvarConfig(parcial, usuario) {
    const permitido = Object.keys(CONFIG_PADRAO).filter(k => k !== 'ultimoTextoPublicado');
    for (const k of permitido) if (k in parcial) estado.config[k] = parcial[k];
    estado.config.alertaNumero = String(estado.config.alertaNumero || '').replace(/\D/g, '');
    estado.config.atividadesBase = (estado.config.atividadesBase || []).map(s => String(s).trim()).filter(Boolean);
    estado.config.navios = (estado.config.navios || [])
        .map(n => ({ nome: String(n.nome || '').trim().toUpperCase(), terminal: normalizarTerminal(n.terminal) || 'T-ORE' }))
        .filter(n => n.nome);
    await store.set('config', estado.config);
    auditar(usuario, 'Alterou configurações');
    return estado.config;
}

// =====================================================================
// Plantão
// =====================================================================
function liderDePlantao() {
    return estado.plantao.liderId ? usuarios.porId(estado.plantao.liderId) : null;
}

function precisaNovaEscala() {
    const e = estado.escala;
    if (!e) return true;
    return !!(e.ultimoTurnoEm && Date.now() - new Date(e.ultimoTurnoEm).getTime() > 30 * 3600 * 1000);
}

async function assumirPlantao(usuario) {
    if (!usuarios.podeLiderar(usuario)) throw erro('Só líderes podem assumir o plantão.', 403);
    const t = agora();
    estado.plantao = {
        ...estado.plantao, liderId: usuario.id, liderNome: usuario.nome, liderEmail: usuario.email,
        assumidoEm: t.iso, sugerirNovaEscala: precisaNovaEscala()
    };
    if (estado.escala && !estado.plantao.sugerirNovaEscala) {
        estado.escala.ultimoTurnoEm = t.iso;
        await store.set('escala', estado.escala);
    }
    await store.set('plantao', estado.plantao);
    const eq = equipeDoUsuario(usuario);
    if (eq && estado.ficha.equipes?.modo !== 'MANUAL') {
        await alterarFicha(f => {
            f.equipes = { ...(f.equipes || {}), modo: 'EQUIPES', saindoEquipeId: eq.id, saindoLista: [...eq.membros], saindo: R.juntarNomes(eq.membros) };
            if (/conforme/i.test(f.equipes.assumindo || '')) Object.assign(f.equipes, { assumindo: '', assumindoLista: [], assumindoEquipeId: null });
        });
    }
    auditar(usuario, 'Assumiu o plantão', `${estado.ficha.turno} ${estado.ficha.data}`);
    if (handlers.plantaoMudou) handlers.plantaoMudou(usuario.id);
    return estado.plantao;
}

// =====================================================================
// Ficha do turno
// =====================================================================
async function salvarFicha(ficha, versaoCliente, { substituir = false } = {}) {
    if (versaoCliente !== undefined && versaoCliente !== estado.versao) {
        throw Object.assign(erro('A ficha foi alterada em outro aparelho.', 409), { ficha: estado.ficha });
    }
    const t = agora();
    estado.versao += 1;
    const id = substituir ? ficha.id : estado.ficha.id;
    const fixos = substituir ? {} : { criadoEm: estado.ficha.criadoEm, herdadoDe: estado.ficha.herdadoDe, publicadoEm: estado.ficha.publicadoEm };
    const { avisos, operacoes, ...limpa } = ficha;
    estado.ficha = { ...limpa, ...fixos, id, versao: estado.versao, atualizadoEm: t.iso };
    await store.set('ficha', estado.ficha);
    return estado.ficha;
}

// Alteração feita pelo próprio sistema (robô)
// =====================================================================
// Equipes (cadastro) · equipe saindo = equipe do líder de plantão
// =====================================================================
function equipeDoUsuario(u) {
    if (!u) return null;
    const nome = semAcento(R.nomeProprio(u.nome || '')).toLowerCase();
    return estado.equipes.find(e => (e.lideres || []).includes(u.id))
        || estado.equipes.find(e => (e.membros || []).some(m => semAcento(m).toLowerCase() === nome)) || null;
}
async function salvarEquipe(dados, usuario) {
    const nome = String(dados.nome || '').trim();
    if (!nome) throw erro('Dê um nome para a equipe.');
    const membros = [...new Set((dados.membros || []).map(R.nomeProprio).filter(n => n.length >= 2))];
    if (!membros.length) throw erro('Inclua pelo menos um integrante.');
    const lideres = (dados.lideres || []).filter(id => usuarios.porId(id));
    let eq = dados.id ? estado.equipes.find(e => e.id === dados.id) : null;
    if (dados.id && !eq) throw erro('Equipe não encontrada.', 404);
    // um líder pertence a uma equipe só
    for (const e of estado.equipes) if (e !== eq) e.lideres = (e.lideres || []).filter(id => !lideres.includes(id));
    if (!eq) { eq = { id: novoId(), criadoEm: agora().iso }; estado.equipes.push(eq); }
    Object.assign(eq, { nome, cor: dados.cor || eq.cor || 'azul', membros, lideres });
    await store.set('equipes', estado.equipes);
    auditar(usuario, 'Salvou equipe', `${nome}: ${membros.join(', ')}`);
    return eq;
}
async function excluirEquipe(id, usuario) {
    const eq = estado.equipes.find(e => e.id === id);
    if (!eq) throw erro('Equipe não encontrada.', 404);
    estado.equipes = estado.equipes.filter(e => e.id !== id);
    await store.set('equipes', estado.equipes);
    auditar(usuario, 'Excluiu equipe', eq.nome);
}

// =====================================================================
// Histórico completo de relatórios (todos, por data e turno)
// =====================================================================
function hashTexto(t) {
    const { crc32 } = require('./xlsx');
    return crc32(Buffer.from(semAcento(t || '').replace(/\s+/g, ' ').trim(), 'utf-8')).toString(16).padStart(8, '0');
}
// Um registro por turno (data + turno). Repostagens e correções substituem o texto, sem duplicar.
const PRIORIDADE_ORIGEM = { publicado: 4, grupo: 3, importado: 2, colado: 1 };
function idHistorico(chave, texto) { return chave && !chave.startsWith('0000') ? chave : `sem-data_${hashTexto(texto)}`; }

// Data e turno de um relatório; se o texto não trouxer, deduz pelo horário em que foi postado
// (postado antes do meio-dia = NOTURNO do dia anterior; depois = DIURNO do dia)
function turnoDoRelatorio(texto, mensagemTs) {
    const d = R.lerRelatorio(texto).dados;
    let data = d.data || R.dataDoTexto(texto);
    let turno = d.turno || R.turnoDoTexto(texto);
    if ((!data || !turno) && mensagemTs) {
        const postado = agora(new Date(mensagemTs));
        const cedo = postado.horaNum < 12;
        if (!turno) turno = cedo ? 'NOTURNO' : 'DIURNO';
        if (!data) data = cedo && turno === 'NOTURNO' ? dataDeOntemBR(postado.data) : postado.data;
    }
    return { data, turno };
}
function dataDeOntemBR(dataBR) { return R.turnoAnterior('DIURNO', dataBR).data; }

async function arquivarRelatorio({ texto, autor = '', origem = 'grupo', grupoNome = '', mensagemTs = Date.now(), silencioso = false, flexivel = false }) {
    if (!texto || !(flexivel ? R.ehRelatorioFlexivel(texto) : R.ehRelatorioDeTurno(texto))) return { novo: false, rel: null };
    const d = turnoDoRelatorio(texto, flexivel ? mensagemTs : null);
    const chave = chaveTurno(d.data, d.turno) || '0000-00-00-9';
    const id = idHistorico(chave, texto);
    const hash = hashTexto(texto);
    const existente = estado.historico.find(h => h.id === id);
    if (existente) {
        const mesmoTexto = existente.hash === hash;
        const maisNovo = (mensagemTs || 0) > (existente.mensagemTs || 0);
        const melhorOrigem = (PRIORIDADE_ORIGEM[origem] || 0) > (PRIORIDADE_ORIGEM[existente.origem] || 0);
        if (mesmoTexto && !melhorOrigem) return { novo: false, rel: existente };
        // correção mais nova, ou a mesma versão vinda de uma fonte melhor (publicado > grupo > importado > colado)
        if (maisNovo || melhorOrigem) {
            Object.assign(existente, { texto, hash, autor: autor || existente.autor, origem: melhorOrigem ? origem : existente.origem, grupoNome: grupoNome || existente.grupoNome, mensagemTs: Math.max(mensagemTs || 0, existente.mensagemTs || 0) });
            await store.salvarRelatorio(existente);
            return { novo: false, atualizado: true, rel: existente };
        }
        return { novo: false, rel: existente };
    }
    const rel = {
        id, chave, turno: d.turno || '', data: d.data || '', autor: autor || '', origem, grupoNome: grupoNome || '',
        mensagemTs: mensagemTs || Date.now(), capturadoEm: agora().iso, texto, hash
    };
    estado.historico.push(rel);
    await store.salvarRelatorio(rel);
    if (!silencioso) console.log(`🗂️  [HISTÓRICO] ${origem} • ${rel.turno} ${rel.data}`);
    return { novo: true, rel };
}

// Limpa duplicados antigos (versões anteriores guardavam um registro por texto)
async function deduplicarHistorico() {
    const porId = new Map();
    const remover = [];
    for (const h of estado.historico) {
        const d = turnoDoRelatorio(h.texto || '', h.origem === 'importado' ? h.mensagemTs : null);
        h.chave = chaveTurno(d.data, d.turno) || h.chave || '0000-00-00-9';
        h.turno = d.turno || h.turno; h.data = d.data || h.data;
        const id = idHistorico(h.chave, h.texto);
        h.hash = h.hash || hashTexto(h.texto);
        const atual = porId.get(id);
        const melhor = !atual || (PRIORIDADE_ORIGEM[h.origem] || 0) > (PRIORIDADE_ORIGEM[atual.origem] || 0)
            || ((PRIORIDADE_ORIGEM[h.origem] || 0) === (PRIORIDADE_ORIGEM[atual.origem] || 0) && (h.mensagemTs || 0) > (atual.mensagemTs || 0));
        if (melhor) { if (atual) remover.push(atual); porId.set(id, h); } else remover.push(h);
    }
    const ficam = [];
    for (const [id, h] of porId) {
        if (h.id !== id) { remover.push({ ...h }); h.id = id; await store.salvarRelatorio(h); }
        ficam.push(h);
    }
    for (const r of remover) if (!ficam.some(f => f.id === r.id)) await store.excluirRelatorio(r.id).catch(() => {});
    if (remover.length) console.log(`🧹 [HISTÓRICO] ${remover.length} duplicado(s) removido(s).`);
    estado.historico = ficam;
}

function historicoOrdenado() {
    return [...estado.historico].sort((a, b) => (b.chave || '').localeCompare(a.chave || '') || (b.mensagemTs || 0) - (a.mensagemTs || 0));
}
async function importarMensagens(mensagens, usuario) {
    let novos = 0, atualizados = 0, repetidos = 0, ignorados = 0;
    const datas = [], exemplos = [];
    for (const m of (mensagens || []).slice(0, 5000)) {
        if (!m?.texto || !R.ehRelatorioFlexivel(m.texto)) {
            ignorados++;
            if (exemplos.length < 3 && m?.texto) exemplos.push(m.texto.replace(/\s+/g, ' ').slice(0, 90));
            continue;
        }
        const r = await arquivarRelatorio({ texto: m.texto, autor: m.autor, origem: 'importado', mensagemTs: m.ts, silencioso: true, flexivel: true });
        if (r.rel?.chave && !r.rel.chave.startsWith('0000')) datas.push(r.rel.chave);
        if (r.novo) novos++; else if (r.atualizado) atualizados++; else repetidos++;
    }
    datas.sort();
    auditar(usuario, 'Importou relatórios do WhatsApp', `${novos} novos, ${atualizados} atualizados, ${repetidos} repetidos`);
    return { novos, atualizados, repetidos, ignorados, exemplos, total: estado.historico.length, de: datas[0] || '', ate: datas[datas.length - 1] || '' };
}
async function herdarDoHistorico(id, usuario) {
    const h = estado.historico.find(x => x.id === id);
    if (!h) throw erro('Relatório não encontrado.', 404);
    const rel = await registrarRelatorio({ texto: h.texto, autor: h.autor, manual: true }, usuario);
    return herdar(rel.id, usuario);
}

// =====================================================================
// Publicação: guarda no histórico e prepara o próximo turno
// =====================================================================
async function aposPublicar(texto, usuario, { passarOps = [] } = {}) {
    const { rel } = await arquivarRelatorio({ texto, autor: usuario.nome, origem: 'publicado' });
    const f = estado.ficha;
    const ops = operacoesDaFicha(f.id);
    await arquivarFichaAtual();

    const prox = R.proximoTurno(f.turno, f.data);
    const nova = R.fichaVazia(estado.config);
    nova.turno = prox.turno; nova.data = prox.data;
    const km = f.vtr?.kmFinal ?? f.vtr?.kmInicial ?? null;
    nova.vtr = { modelo: f.vtr?.modelo || nova.vtr.modelo, placa: f.vtr?.placa || nova.vtr.placa, kmInicial: km, kmFinal: km };
    nova.sistemas = { ...nova.sistemas, cftv: f.sistemas?.cftv || '', ca: f.sistemas?.ca || '✓ S/A' };
    // navios continuam; as linhas das operações deste turno não se repetem
    const linhasOps = new Set(ops.map(o => o.linhaNavio?.linha).filter(Boolean));
    const copiar = lista => (lista || []).map(n => ({ ...n, id: novoId(), linhas: (n.linhas || []).filter(l => !linhasOps.has(l)) })).filter(n => n.linhas.length);
    nova.navios = { tore: copiar(f.navios?.tore), toil: copiar(f.navios?.toil) };
    // quem assumiu agora sai no próximo
    const lista = f.equipes?.assumindoLista?.length ? f.equipes.assumindoLista : R.separarNomes(f.equipes?.assumindo);
    nova.equipes = lista.length
        ? { modo: 'EQUIPES', saindo: R.juntarNomes(lista), saindoLista: [...lista], saindoEquipeId: f.equipes?.assumindoEquipeId || null, assumindo: '', assumindoLista: [], assumindoEquipeId: null }
        : { modo: 'ESCALA', saindo: 'Conforme escala', assumindo: 'Conforme escala', saindoLista: [], assumindoLista: [] };
    nova.anterior = { assumindo: f.equipes?.assumindo || '', kmFinal: km, turno: f.turno, data: f.data };
    nova.herdadoDe = { publicado: true, relatorioId: rel?.id || null, autor: usuario.nome, data: f.data, turno: f.turno, capturadoEm: agora().iso, encontrados: [], faltando: [] };

    // operações sem saída que o líder decidiu passar adiante
    let passadas = 0;
    for (const o of ops) {
        const semRetorno = o.tipo === 'TRIPULACAO' && /^Sa[ií]da/i.test(o.movimento || '') && !o.horaRetorno;
        if ((o.horaFinal && !semRetorno) || !passarOps.includes(o.id)) continue;
        o.fichaId = nova.id;
        o.linhaNavio = null;
        if (o.navio && o.terminal) {
            o.linhaNavio = { terminal: o.terminal, navio: o.navio, linha: R.resumoNavio(o) };
            R.trocarLinhaNavio(nova, null, o.linhaNavio);
        }
        passadas++;
    }
    await salvarOperacoes();
    estado.plantao.relatorioPendenteId = null;
    await store.set('plantao', estado.plantao);
    auditar(usuario, 'Preparou o próximo turno', `${nova.turno} ${nova.data}${passadas ? ` · ${passadas} operação(ões) em andamento` : ''}`);
    return salvarFicha(nova, undefined, { substituir: true });
}

// Navios conhecidos = cadastro + navios que já estão na seção 6 do turno
// Os navios que estão na seção 6 do turno vêm primeiro: o terminal onde o navio está agora vale mais que o cadastro.
function naviosConhecidos() {
    const lista = [];
    const f = estado.ficha || {};
    for (const [k, term] of [['tore', 'T-ORE'], ['toil', 'T-OIL']]) {
        for (const n of f.navios?.[k] || []) {
            if (n.navio && !lista.some(x => R.chaveNavio(x.nome) === R.chaveNavio(n.navio))) lista.push({ nome: n.navio, terminal: term });
        }
    }
    for (const n of estado.config.navios || []) if (!lista.some(x => R.chaveNavio(x.nome) === R.chaveNavio(n.nome))) lista.push(n);
    return lista;
}

// ---- Equipes (seção 8): lista de nomes para os botões
function nomesDaEquipe() {
    const cfg = estado.config;
    const ocultos = new Set((cfg.equipeOcultos || []).map(n => semAcento(n).toLowerCase()));
    const mapa = new Map();
    const add = n => { const nome = R.nomeProprio(n); const k = semAcento(nome).toLowerCase(); if (nome.length >= 2 && !ocultos.has(k) && !mapa.has(k)) mapa.set(k, nome); };
    (cfg.equipe || []).forEach(add);
    for (const e of estado.equipes || []) (e.membros || []).forEach(add);
    const f = estado.ficha || {};
    [f.equipes?.saindo, f.equipes?.assumindo, f.anterior?.assumindo].forEach(t => R.separarNomes(t).forEach(add));
    for (const r of estado.relatorios || []) [r.dados?.equipes?.saindo, r.dados?.equipes?.assumindo].forEach(t => R.separarNomes(t).forEach(add));
    return [...mapa.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
async function adicionarNomeEquipe(nome, usuario) {
    const n = R.nomeProprio(nome);
    if (n.length < 2) throw erro('Informe o nome.');
    const k = semAcento(n).toLowerCase();
    const cfg = estado.config;
    cfg.equipe = [...(cfg.equipe || []).filter(x => semAcento(x).toLowerCase() !== k), n];
    cfg.equipeOcultos = (cfg.equipeOcultos || []).filter(x => semAcento(x).toLowerCase() !== k);
    await store.set('config', cfg);
    auditar(usuario, 'Adicionou nome à equipe', n);
    return nomesDaEquipe();
}
async function removerNomeEquipe(nome, usuario) {
    const k = semAcento(R.nomeProprio(nome)).toLowerCase();
    const cfg = estado.config;
    cfg.equipe = (cfg.equipe || []).filter(x => semAcento(x).toLowerCase() !== k);
    cfg.equipeOcultos = [...new Set([...(cfg.equipeOcultos || []), R.nomeProprio(nome)])];
    await store.set('config', cfg);
    auditar(usuario, 'Removeu nome da lista da equipe', nome);
    return nomesDaEquipe();
}

async function alterarFicha(fn) {
    const copia = JSON.parse(JSON.stringify(estado.ficha));
    fn(copia);
    return salvarFicha(copia);
}

function fichaTocada(f) { return f && (f.publicadoEm || f.atualizadoEm !== f.criadoEm); }

async function arquivarFichaAtual() {
    const f = estado.ficha;
    if (!fichaTocada(f)) return;
    await store.arquivarTurno({ ...f, avisos: avisosAbertos(), operacoes: operacoesDaFicha(f.id) });
    coletarNaEscala(f);
}

function avisosAbertos() {
    return estado.pendencias.filter(p => p.tipo === 'AVISO' && p.status === 'ABERTA');
}

function operacoesDaFicha(fichaId) {
    return estado.operacoes.filter(o => o.fichaId === fichaId || !o.horaFinal);
}

function textoRelatorio({ negrito = true } = {}) {
    return R.formatarRelatorio(estado.ficha, avisosAbertos(), { negrito });
}

function conferencia() {
    return R.conferirFicha(estado.ficha, operacoesDaFicha(estado.ficha.id));
}

async function herdar(relatorioId, usuario) {
    const rel = relatorioId ? estado.relatorios.find(r => r.id === relatorioId) : estado.relatorios[0];
    if (!rel) throw erro('Nenhum relatório da equipe anterior foi capturado. Use "Colar relatório".', 404);
    await arquivarFichaAtual();
    const nova = R.fichaHerdada(rel, estado.ficha, estado.config);
    // avisos do relatório recebido viram pendências (sem duplicar os que já estão abertos)
    const chave = s => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
    for (const av of rel.dados.avisos || []) {
        if (!(av.titulo || av.texto)) continue;
        if (estado.pendencias.some(p => p.status === 'ABERTA' && chave(p.titulo) === chave(av.titulo))) continue;
        estado.pendencias.push(novaPendencia({ tipo: 'AVISO', titulo: av.titulo, texto: av.texto }, null, `Relatório ${rel.dados.turno || ''} ${rel.dados.data || ''} (${rel.autor || 'equipe anterior'})`, nova));
    }
    rel.herdadoEm = agora().iso;
    estado.plantao.relatorioPendenteId = null;
    await Promise.all([store.set('relatorios_us', estado.relatorios), store.set('pendencias', estado.pendencias), store.set('plantao', estado.plantao)]);
    auditar(usuario, usuario ? 'Herdou o relatório anterior' : 'Herdou automaticamente o relatório anterior', `${rel.dados.turno || ''} ${rel.dados.data || ''} · ${rel.autor || ''}`);
    return salvarFicha(nova, undefined, { substituir: true });
}

async function novaFichaEmBranco(usuario) {
    await arquivarFichaAtual();
    const nova = R.fichaVazia(estado.config);
    nova.vtr.kmInicial = nova.vtr.kmFinal = estado.ficha?.vtr?.kmFinal ?? null;
    nova.navios = JSON.parse(JSON.stringify(estado.ficha?.navios || { tore: [], toil: [] }));
    nova.anterior = { assumindo: estado.ficha?.equipes?.assumindo || '', kmFinal: estado.ficha?.vtr?.kmFinal ?? null, turno: estado.ficha?.turno || '', data: estado.ficha?.data || '' };
    auditar(usuario, 'Começou turno em branco');
    return salvarFicha(nova, undefined, { substituir: true });
}

async function marcarPublicado(texto, usuario) {
    estado.config.ultimoTextoPublicado = assinatura(texto);
    await store.set('config', estado.config);
    estado.ficha.publicadoEm = agora().iso;
    await store.set('ficha', estado.ficha);
    auditar(usuario, 'Publicou o relatório no grupo', `${estado.ficha.turno} ${estado.ficha.data}`);
}

// =====================================================================
// Relatórios da equipe anterior (últimos 10)
// =====================================================================
function assinatura(texto) { return semAcento(texto || '').replace(/\W/g, '').slice(0, 500); }

function ehNossoRelatorio(texto, lido, msg = {}) {
    if (msg.fromMe) return true;
    if (assinatura(texto) === estado.config.ultimoTextoPublicado) return true;
    const numero = String(msg.remetenteNumero || '').replace(/\D/g, '');
    if (numero && usuarios.todos().some(u => u.telefone && numero.endsWith(u.telefone.slice(-9)))) return true;
    const f = estado.ficha;
    return !!(f && lido.dados.data === f.data && lido.dados.turno === f.turno && f.publicadoEm);
}

async function registrarRelatorio({ texto, autor, grupoNome, chatId, manual = false, mensagemTs = Date.now() }, usuario = null) {
    const ass = assinatura(texto);
    const existente = estado.relatorios.find(r => r.assinatura === ass);
    if (existente) return existente;
    const lido = R.lerRelatorio(texto);
    const rel = {
        id: novoId(), texto, autor: autor || '', grupoNome: grupoNome || '', chatId: chatId || '',
        manual, capturadoEm: agora().iso, mensagemTs, herdadoEm: null, assinatura: ass, ...lido
    };
    estado.relatorios.unshift(rel);
    estado.relatorios.sort((a, b) => (b.mensagemTs || 0) - (a.mensagemTs || 0));
    await arquivarRelatorio({ texto, autor, origem: manual ? 'colado' : 'grupo', grupoNome, mensagemTs });
    estado.relatorios = estado.relatorios.slice(0, LIMITE_RELATORIOS);
    await store.set('relatorios_us', estado.relatorios);
    console.log(`📑 [RELATÓRIO] ${manual ? 'Colado' : 'Capturado de ' + autor} • ${lido.dados.turno || '?'} ${lido.dados.data || '?'} • faltando: ${lido.faltando.join(', ') || 'nada'}`);
    auditar(usuario, manual ? 'Colou um relatório anterior' : 'Capturou relatório do grupo', `${lido.dados.turno || ''} ${lido.dados.data || ''} · ${autor || ''}`);
    if (!manual) await decidirHeranca(rel);
    return rel;
}

// Herda sozinho quando é seguro; senão, pergunta na Central
async function decidirHeranca(rel) {
    const f = estado.ficha;
    const kRel = chaveTurno(rel.dados.data, rel.dados.turno);
    const kFicha = chaveTurno(f.data, f.turno);
    // Só troca sozinho se o turno atual está intocado ou se o relatório é de um turno MAIS NOVO que o atual.
    // Correções/repostagens do relatório já herdado nunca apagam o turno em andamento: o robô pergunta.
    const ant = R.turnoAnterior(f.turno, f.data);
    const kAnterior = chaveTurno(ant.data, ant.turno);
    if (kRel && kAnterior && kRel < kAnterior) return; // relatório antigo: só fica no histórico
    const seguro = !fichaTocada(f) || (kRel && kFicha && kRel > kFicha);
    if (seguro) {
        await herdar(rel.id, null);
        console.log('📥 [HERANÇA] Turno preparado automaticamente.');
    } else {
        estado.plantao.relatorioPendenteId = rel.id;
        await store.set('plantao', estado.plantao);
    }
}

async function dispensarRelatorioPendente(usuario) {
    estado.plantao.relatorioPendenteId = null;
    await store.set('plantao', estado.plantao);
    auditar(usuario, 'Manteve o turno atual (ignorou relatório novo)');
}

// =====================================================================
// Pendências (avisos e Digital) com histórico e tratativas
// =====================================================================
function novaPendencia({ tipo, titulo, texto }, usuario, origem = '', ficha = estado.ficha) {
    const t = agora();
    return {
        id: novoId(), tipo: tipo === 'DIGITAL' ? 'DIGITAL' : 'AVISO',
        titulo: String(titulo || '').trim().toUpperCase(), texto: String(texto || '').trim(),
        status: 'ABERTA', origem, criadoEm: t.iso, criadoPor: quem(usuario),
        turno: ficha?.turno || '', data: ficha?.data || t.data,
        historico: [{ tipo: 'CRIACAO', em: t.iso, data: t.data.slice(0, 5), hora: t.hora, por: usuario ? usuario.nome : 'Robô', texto: origem }]
    };
}

async function salvarPendencias() {
    const limite = Date.now() - 30 * 24 * 3600 * 1000;
    estado.pendencias = estado.pendencias.filter(p => p.status === 'ABERTA' || new Date(p.concluidoEm || 0).getTime() > limite);
    await store.set('pendencias', estado.pendencias);
}

async function criarPendencia(dados, usuario, origem = 'Registrada manualmente') {
    if (!(dados.titulo || '').trim() && !(dados.texto || '').trim()) throw erro('Preencha o título ou a descrição.');
    const p = novaPendencia(dados, usuario, origem);
    if (!p.titulo) p.titulo = p.texto.split('\n')[0].slice(0, 60).toUpperCase();
    estado.pendencias.push(p);
    await salvarPendencias();
    auditar(usuario, `Criou ${p.tipo === 'DIGITAL' ? 'pendência da Digital' : 'aviso'}`, p.titulo);
    return p;
}

function pendencia(id) {
    const p = estado.pendencias.find(x => x.id === id);
    if (!p) throw erro('Pendência não encontrada.', 404);
    return p;
}

async function atualizarPendencia(id, texto, usuario) {
    const p = pendencia(id);
    if (!String(texto || '').trim()) throw erro('Escreva a atualização.');
    const t = agora();
    p.historico.push({ tipo: 'ATUALIZACAO', em: t.iso, data: t.data.slice(0, 5), hora: t.hora, por: usuario.nome, texto: texto.trim() });
    await salvarPendencias();
    auditar(usuario, 'Atualizou pendência', p.titulo);
    return p;
}

async function editarPendencia(id, { titulo, texto, tipo, tratativa }, usuario) {
    const p = pendencia(id);
    if (titulo !== undefined) {
        if (!String(titulo).trim()) throw erro('O título não pode ficar vazio.');
        p.titulo = String(titulo).trim().toUpperCase();
    }
    if (texto !== undefined) p.texto = String(texto).trim();
    if (tipo === 'AVISO' || tipo === 'DIGITAL') p.tipo = tipo;
    if (tratativa !== undefined && p.status === 'CONCLUIDA') {
        if (!String(tratativa).trim()) throw erro('Informe como foi resolvido.');
        p.tratativa = String(tratativa).trim();
        const ult = [...p.historico].reverse().find(h => h.tipo === 'CONCLUSAO');
        if (ult) ult.texto = p.tratativa;
    }
    await salvarPendencias();
    auditar(usuario, 'Editou pendência', p.titulo);
    return p;
}

async function concluirPendencia(id, { tratativa, registrarAtividade }, usuario) {
    const p = pendencia(id);
    if (!String(tratativa || '').trim()) throw erro('Descreva a tratativa (o que foi feito).');
    const t = agora();
    p.status = 'CONCLUIDA';
    p.tratativa = tratativa.trim();
    p.concluidoEm = t.iso;
    p.concluidoPor = quem(usuario);
    p.historico.push({ tipo: 'CONCLUSAO', em: t.iso, data: t.data.slice(0, 5), hora: t.hora, por: usuario.nome, texto: p.tratativa });
    await salvarPendencias();
    if (registrarAtividade) {
        await alterarFicha(f => f.atividades.push({ id: novoId(), texto: `${t.hora}h ${p.titulo}: ${p.tratativa}` }));
    }
    auditar(usuario, 'Concluiu pendência', `${p.titulo} — ${p.tratativa}`);
    return p;
}

async function reabrirPendencia(id, usuario) {
    const p = pendencia(id);
    const t = agora();
    p.status = 'ABERTA';
    p.historico.push({ tipo: 'ATUALIZACAO', em: t.iso, data: t.data.slice(0, 5), hora: t.hora, por: usuario.nome, texto: 'Pendência reaberta.' });
    await salvarPendencias();
    auditar(usuario, 'Reabriu pendência', p.titulo);
    return p;
}

async function excluirPendencia(id, usuario) {
    const p = pendencia(id);
    estado.pendencias = estado.pendencias.filter(x => x.id !== id);
    await salvarPendencias();
    auditar(usuario, 'Excluiu pendência', p.titulo);
}

// =====================================================================
// Operações de bordo + e-mail para o líder de plantão
// =====================================================================
const CAMPOS_OPERACAO = ['tipo', 'navio', 'terminal', 'empresa', 'responsavel', 'agente', 'ajudante', 'aBordo', 'veiculo', 'placa', 'quantidade',
    'movimento', 'horaInicial', 'horaFinal', 'horaRetorno', 'autoridades', 'autorizadoTerminal', 'observacoes', 'status', 'conferir', 'alertas'];

function limparOperacao(d) {
    const o = {};
    for (const k of CAMPOS_OPERACAO) if (d[k] !== undefined) o[k] = typeof d[k] === 'string' ? d[k].trim() : d[k];
    if (o.tipo && !R.TIPOS_OPERACAO[o.tipo]) o.tipo = R.tipoOperacaoDoTexto(o.tipo);
    if (o.navio !== undefined) o.navio = o.navio.toUpperCase();
    if (o.terminal !== undefined) o.terminal = normalizarTerminal(o.terminal) || o.terminal.toUpperCase();
    if (o.placa !== undefined) o.placa = lerPlacas(o.placa).texto || o.placa.toUpperCase();   // várias placas: nenhuma é descartada
    if (o.horaInicial !== undefined) o.horaInicial = normalizarHora(o.horaInicial);
    if (o.horaFinal !== undefined) o.horaFinal = normalizarHora(o.horaFinal);
    if (o.horaRetorno !== undefined) o.horaRetorno = normalizarHora(o.horaRetorno);
    for (const k of ['empresa', 'responsavel', 'agente', 'ajudante', 'aBordo', 'veiculo']) if (o[k] !== undefined) o[k] = o[k].toUpperCase();
    for (const k of ['conferir', 'alertas']) if (o[k] !== undefined && !Array.isArray(o[k])) delete o[k];
    return o;
}

function operacao(id) {
    const o = estado.operacoes.find(x => x.id === id);
    if (!o) throw erro('Operação não encontrada.', 404);
    return o;
}

async function salvarOperacoes() {
    const limite = Date.now() - 15 * 24 * 3600 * 1000;
    estado.operacoes = estado.operacoes.filter(o => !o.horaFinal || new Date(o.criadoEm || 0).getTime() > limite);
    await store.set('operacoes', estado.operacoes);
}

function destinatarioEmail() {
    const lider = liderDePlantao();
    return lider?.email || estado.config.emailPadrao || usuarios.admin()?.email || '';
}

async function enviarEmailOperacao(op, { forcar = false, usuario = null } = {}) {
    if (!op.horaFinal && !forcar) return op;
    if (op.email?.enviadoEm && !forcar) return op;
    const cfg = estado.config;
    const { assunto, corpo } = R.minutaEmail(op);
    const lider = destinatarioEmail();
    const direto = !!(cfg.emailDiretoOficial && cfg.emailDestinatarios);
    const para = direto ? cfg.emailDestinatarios : lider;
    const cc = direto ? [lider, cfg.emailCopia].filter(Boolean).join('; ') : '';

    const reserva = async motivo => {
        op.email = { ...(op.email || {}), status: email.configurado() ? 'ERRO' : 'SEM_CONTA', erro: motivo, tentativaEm: agora().iso };
        if (cfg.minutaNoWhatsapp && handlers.minutaWhatsapp && !op.email.whatsappEm) {
            try {
                if (await handlers.minutaWhatsapp({ assunto, corpo, op })) op.email.whatsappEm = agora().iso;
            } catch (e) { console.error('⚠️  [MINUTA WHATSAPP]', e.message); }
        }
    };

    if (!email.configurado()) {
        await reserva(email.motivoIndisponivel());
    } else {
        try {
            await email.enviar({ para, cc, assunto, corpo });
            op.email = { status: 'ENVIADO', enviadoEm: agora().iso, para, cc, direto };
            if (direto) op.email.encaminhadoEm = op.email.enviadoEm; // já foi para a lista oficial
            auditar(usuario, direto ? 'E-mail de bordo enviado à lista oficial' : 'E-mail de bordo enviado ao líder', `${assunto} → ${para}`);
        } catch (e) {
            console.error('⚠️  [E-MAIL] Falha ao enviar:', e.message);
            await reserva(e.message);
        }
    }
    await salvarOperacoes();
    return op;
}

// Todas as minutas que ainda não foram encaminhadas (para copiar manualmente)
function minutasPendentes() {
    return estado.operacoes
        .filter(o => o.horaFinal && !o.email?.encaminhadoEm)
        .map(o => ({ id: o.id, navio: o.navio, tipo: o.tipo, status: o.email?.status || 'PENDENTE', ...R.minutaEmail(o) }));
}

// Cria uma operação por navio e as linhas da seção 6 (operações de bordo não vão para a seção 4)
async function registrarOperacoes(rascunhos, { atividadeTexto = '', entradaId = null, autor = '', usuario = null } = {}) {
    if (!rascunhos?.length) throw erro('Nenhuma operação informada.');
    const t = agora();
    const ficha = estado.ficha;
    const novas = rascunhos.map(r => {
        const o = limparOperacao({ autoridades: '', autorizadoTerminal: '', observacoes: '', status: 'Sem alteração', ...r });
        if (o.navio) {
            const conhecido = R.acharNavio(o.navio, naviosConhecidos());
            o.navio = R.nomeNavioLimpo(conhecido ? conhecido.nome : o.navio);
            if (!o.terminal && conhecido) o.terminal = conhecido.terminal;
        }
        if (!o.autoridades) o.autoridades = (R.TIPOS_OPERACAO[o.tipo] || R.TIPOS_OPERACAO.OUTRA).autoridade;
        return { id: novoId(), ...o, data: ficha.data, fichaId: ficha.id, criadoEm: t.iso, criadoPor: quem(usuario), origem: { entradaId, autor }, email: {} };
    });
    estado.operacoes.push(...novas);
    const atividadeId = atividadeTexto ? novoId() : null;
    await alterarFicha(f => {
        if (atividadeTexto) f.atividades.push({ id: atividadeId, texto: atividadeTexto, opIds: novas.map(o => o.id) });
        for (const o of novas) {
            if (!o.navio || !o.terminal) continue;
            o.linhaNavio = { terminal: o.terminal, navio: o.navio, linha: R.resumoNavio(o) };
            R.trocarLinhaNavio(f, null, o.linhaNavio);
        }
    });
    for (const o of novas) o.atividadeId = atividadeId;
    await salvarOperacoes();
    auditar(usuario, usuario ? 'Registrou operação de bordo' : 'Registrou operação automaticamente', novas.map(o => `${R.TIPOS_OPERACAO[o.tipo]?.rotulo} · ${o.navio}`).join(' | '));
    for (const o of novas) if (o.horaFinal) enviarEmailOperacao(o, { usuario }).catch(() => {});
    return novas;
}

// Atualiza (no lugar) a linha da operação dentro do navio, na seção 6 do turno em que ela foi registrada
function linhaDoNavio(f, o, remover = false) {
    if (o.fichaId && f.id && o.fichaId !== f.id) return;
    const depois = remover || !o.navio || !o.terminal ? null : { terminal: o.terminal, navio: o.navio, linha: R.resumoNavio(o) };
    R.trocarLinhaNavio(f, o.linhaNavio, depois);
    o.linhaNavio = depois;
}

async function registrarSaida(id, hora, usuario = null) {
    const o = operacao(id);
    o.horaFinal = normalizarHora(hora) || agora().hora;
    await alterarFicha(f => {
        const placa = (o.placa || '').replace('-', '');
        const a = f.atividades.find(x => (x.opIds || []).includes(o.id)) ||
            [...f.atividades].reverse().find(x => placa && x.texto.toUpperCase().replace(/-/g, '').includes(placa));
        if (a && !/sa[ií]da [àa]s/i.test(a.texto)) a.texto = `${a.texto.trim()} Saída às ${o.horaFinal}h.`;
        linhaDoNavio(f, o);
    });
    await salvarOperacoes();
    auditar(usuario, usuario ? 'Registrou saída de veículo' : 'Registrou saída automaticamente', `${o.navio} · ${o.placa || ''} · ${o.horaFinal}`);
    enviarEmailOperacao(o, { usuario }).catch(() => {});
    return o;
}

async function atualizarOperacao(id, dados, usuario) {
    const o = operacao(id);
    const tinhaSaida = !!o.horaFinal;
    const limpos = limparOperacao(dados);
    registrarHistorico(o, limpos, usuario ? usuario.nome : 'Correção');
    Object.assign(o, limpos);
    if (o.navio) {
        const conhecido = R.acharNavio(o.navio, naviosConhecidos());
        o.navio = R.nomeNavioLimpo(conhecido ? conhecido.nome : o.navio);
    }
    if (usuario && dados.conferir === undefined) o.conferir = [];   // o líder conferiu e salvou
    await alterarFicha(f => linhaDoNavio(f, o));
    await salvarOperacoes();
    auditar(usuario, 'Editou operação de bordo', `${o.navio} · ${R.TIPOS_OPERACAO[o.tipo]?.rotulo}`);
    if (!tinhaSaida && o.horaFinal) enviarEmailOperacao(o, { usuario }).catch(() => {});
    return o;
}

// Guarda o que mudou na operação (nada se perde: o valor antigo fica no histórico)
function registrarHistorico(o, novos, origem) {
    const mudou = {};
    for (const [k, v] of Object.entries(novos)) {
        if (['conferir', 'alertas'].includes(k)) continue;
        if ((o[k] ?? '') !== (v ?? '')) mudou[k] = { de: o[k] ?? '', para: v ?? '' };
    }
    if (!Object.keys(mudou).length) return false;
    o.historico = [...(o.historico || []), { em: agora().iso, origem, mudou }].slice(-30);
    if (o.email?.enviadoEm) o.email.alteradoAposEnvio = agora().iso;   // e-mail já tinha saído: avisar para reenviar
    return true;
}

async function excluirOperacao(id, usuario) {
    const o = operacao(id);
    estado.operacoes = estado.operacoes.filter(x => x.id !== id);
    if (o.linhaNavio) await alterarFicha(f => linhaDoNavio(f, o, true));
    await salvarOperacoes();
    auditar(usuario, 'Excluiu operação de bordo', `${o.navio} · ${R.TIPOS_OPERACAO[o.tipo]?.rotulo}`);
}

async function marcarEmailOperacao(id, campo, usuario) {
    const o = operacao(id);
    o.email = { ...(o.email || {}), [campo]: agora().iso };
    await salvarOperacoes();
    if (campo === 'encaminhadoEm') auditar(usuario, 'Marcou e-mail como encaminhado', `${o.navio}`);
    return o;
}

// =====================================================================
// Caixa de entrada (mensagens do grupo)
// =====================================================================
function salvarEntradaDepois() { salvarDepois('entrada', () => estado.entrada); }

async function receberMensagem(msg) {
    // msg: { id, editaId, apagaId, chatId, grupoNome, autor, remetenteNumero, texto, timestamp, fromMe, historico }
    if (msg.apagaId) return mensagemApagada(msg.apagaId);
    if (!msg.texto || !msg.texto.trim()) return;
    if (estado.entrada.some(e => e.id === msg.id)) return;

    if (R.ehRelatorioDeTurno(msg.texto)) {
        const lido = R.lerRelatorio(msg.texto);
        if (ehNossoRelatorio(msg.texto, lido, msg)) {
            await arquivarRelatorio({ texto: msg.texto, autor: msg.autor, origem: 'publicado', grupoNome: msg.grupoNome, mensagemTs: msg.timestamp });
            return;
        }
        return registrarRelatorio({ texto: msg.texto, autor: msg.autor, grupoNome: msg.grupoNome, chatId: msg.chatId, mensagemTs: msg.timestamp });
    }

    if (msg.editaId) {
        const original = estado.entrada.find(e => e.id === msg.editaId);
        if (original) return mensagemEditada(original, msg.texto);
    }

    const t = agora(new Date(msg.timestamp || Date.now()));
    const c = R.classificarMensagem(msg.texto, naviosConhecidos(), t.hora);
    const item = {
        id: msg.editaId || msg.id, chatId: msg.chatId, grupoNome: msg.grupoNome || '', autor: msg.autor || '',
        texto: msg.texto.trim(), ts: msg.timestamp || Date.now(), data: t.data, hora: t.hora,
        fromMe: !!msg.fromMe, sugestao: c.sugestao, urgente: c.urgente, campos: c.campos,
        rascunhos: c.rascunhos, estruturada: c.estruturada, atividade: c.atividade || '',
        status: c.ruido ? 'ignorado' : 'pendente', destino: null, editado: !!msg.editaId
    };
    estado.entrada.push(item);
    estado.entrada.sort((a, b) => a.ts - b.ts);
    if (estado.entrada.length > LIMITE_ENTRADA) {
        const excesso = estado.entrada.length - LIMITE_ENTRADA;
        let removidos = 0;
        estado.entrada = estado.entrada.filter(e => (removidos < excesso && e.status !== 'pendente') ? (removidos++, false) : true);
        if (estado.entrada.length > LIMITE_ENTRADA) estado.entrada = estado.entrada.slice(-LIMITE_ENTRADA);
    }
    salvarEntradaDepois();

    // Automação: só para mensagens recentes (inclui as que chegaram com o robô fora do ar)
    const recente = Date.now() - item.ts < DOZE_HORAS;
    if (recente) await processarAutomatico(item).catch(e => console.error('⚠️  Automação:', e.message));

    if (item.urgente && Date.now() - item.ts < 30 * 60 * 1000 && handlers.alerta && estado.config.alertasAtivos) handlers.alerta(item);
}

// ---------------------------------------------------------------------
// Mensagem apagada no grupo: o que ela gerou sai do relatório e dos e-mails
// ---------------------------------------------------------------------
async function mensagemApagada(id) {
    const item = estado.entrada.find(e => e.id === id);
    if (!item || item.apagado) return;
    item.apagado = agora().iso;
    item.status = 'ignorado';
    const removidas = [], mantidas = [];
    for (const opId of item.opIds || []) {
        const o = estado.operacoes.find(x => x.id === opId);
        if (!o) continue;
        if (o.email?.enviadoEm) {
            // e-mail já saiu: não apaga sozinho, deixa para o líder decidir
            o.conferir = [...new Set([...(o.conferir || []), 'A mensagem do grupo que gerou esta operação foi APAGADA, mas o e-mail já tinha sido enviado — conferir'])];
            mantidas.push(o);
        } else {
            estado.operacoes = estado.operacoes.filter(x => x.id !== o.id);
            if (o.linhaNavio) await alterarFicha(f => linhaDoNavio(f, o, true));
            removidas.push(o);
        }
    }
    item.opIds = mantidas.map(o => o.id);
    item.destino = [
        'Apagada no grupo',
        removidas.length ? `${removidas.length} operação(ões) retirada(s) do relatório` : '',
        mantidas.length ? `${mantidas.length} com e-mail já enviado — conferir` : ''
    ].filter(Boolean).join(' · ');
    await salvarOperacoes();
    salvarEntradaDepois();
    if (removidas.length || mantidas.length) auditar(null, 'Mensagem apagada no grupo', `${item.autor} · ${item.hora} · ${item.destino}`);
    // mensagens que estavam paradas como "possível duplicidade" desta operação agora podem seguir
    const ids = new Set(removidas.map(o => o.id));
    for (const outro of estado.entrada.filter(e => e.duplicataDe && ids.has(e.duplicataDe) && e.status === 'pendente')) {
        outro.duplicataDe = null; outro.destino = null;
        await processarAutomatico(outro).catch(e => console.error('⚠️  Automação:', e.message));
    }
}

// ---------------------------------------------------------------------
// Mensagem editada no grupo: relatório e e-mail acompanham a correção
// ---------------------------------------------------------------------
async function mensagemEditada(item, textoNovo) {
    const t = agora(new Date(item.ts || Date.now()));
    const c = R.classificarMensagem(textoNovo, naviosConhecidos(), t.hora);
    item.textoOriginal = item.textoOriginal || item.texto;
    Object.assign(item, { texto: textoNovo.trim(), editado: agora().iso, campos: c.campos, urgente: c.urgente, rascunhos: c.rascunhos, estruturada: c.estruturada, atividade: c.atividade || '', sugestao: c.sugestao });

    const ops = (item.opIds || []).map(id => estado.operacoes.find(o => o.id === id)).filter(Boolean);
    if (!ops.length) {
        // ainda não tinha virado operação: reavalia do zero
        if (item.status !== 'usado') {
            item.status = c.ruido ? 'ignorado' : 'pendente'; item.destino = null; item.duplicataDe = null;
            if (Date.now() - item.ts < DOZE_HORAS) await processarAutomatico(item).catch(e => console.error('⚠️  Automação:', e.message));
        }
        salvarEntradaDepois();
        return;
    }

    const rasc = c.sugestao === 'OPERACAO' ? (c.rascunhos || []) : [];
    let alteradas = 0;
    await alterarFicha(f => {
        ops.forEach((o, i) => {
            const r = rasc[i];
            if (!r) return;
            const novos = limparOperacao({ ...r, horaFinal: r.horaFinal || o.horaFinal || '' });
            if (registrarHistorico(o, novos, 'Mensagem editada no grupo')) alteradas++;
            Object.assign(o, novos);
            linhaDoNavio(f, o);
        });
    });
    // a edição tirou navios da mensagem: as operações que sobraram ficam para o líder conferir
    for (const o of ops.slice(rasc.length)) {
        o.conferir = [...new Set([...(o.conferir || []), 'A mensagem do grupo foi editada e não cita mais esta operação — conferir'])];
    }
    // a edição acrescentou navios: cria as operações novas
    if (rasc.length > ops.length) {
        const novas = await registrarOperacoes(rasc.slice(ops.length), { entradaId: item.id, autor: item.autor });
        item.opIds = [...item.opIds, ...novas.map(o => o.id)];
    }
    const base = String(item.destino || 'Operação de bordo').replace(/ · editada no grupo.*$/, '');
    item.destino = `${base} · editada no grupo${alteradas ? ` (${alteradas} operação(ões) corrigida(s))` : ''}`;
    await salvarOperacoes();
    salvarEntradaDepois();
    if (alteradas) auditar(null, 'Operação corrigida pela edição no grupo', `${item.autor} · ${ops.map(o => o.navio).join(', ')}`);
}

function mesmaPlaca(a, b) { return placasEmComum(a, b); }
function mesmoNavio(a, b) {
    return !a || !b || R.chaveNavio(a) === R.chaveNavio(b);
}
function minutos(h) { const m = String(h || '').match(/^(\d{2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; }

// Mesma operação já registrada (mensagem repetida/reenviada)?
function operacaoParecida(r, item) {
    const ficha = estado.ficha || {};
    return estado.operacoes.find(o => {
        if (o.origem?.entradaId === item.id) return false;
        if (o.fichaId !== ficha.id && o.horaFinal) return false;
        if (!o.navio || !r.navio || R.chaveNavio(o.navio) !== R.chaveNavio(r.navio) || o.tipo !== r.tipo) return false;
        if (r.tipo === 'TRIPULACAO' && (o.movimento !== r.movimento || (o.quantidade || '') !== (r.quantidade || ''))) return false;
        if (r.placa && o.placa) return mesmaPlaca(o.placa, r.placa);
        const a = minutos(o.horaInicial), b = minutos(r.horaInicial);
        return a !== null && b !== null && Math.abs(a - b) <= 30;
    });
}

async function processarAutomatico(item) {
    const ehSaida = R.ehMensagemDeSaida(item.texto);

    if (item.sugestao === 'OPERACAO' && item.rascunhos?.length && item.rascunhos[0].navio) {
        const r0 = item.rascunhos[0];
        // texto livre só é automático com dados suficientes (navio + terminal + placa/empresa/quantidade)
        const suficiente = item.estruturada || (r0.terminal && (r0.placa || r0.empresa || r0.quantidade));
        if (!suficiente) return;

        // "Retorno dos 05 tripulantes do navio X": fecha a saída a passeio em aberto (não cria operação nova)
        if (item.rascunhos.every(r => r.tipo === 'TRIPULACAO' && r.movimento === 'Retorno')) {
            let fechadas = 0;
            for (const r of item.rascunhos) {
                const saida = estado.operacoes.filter(o => o.tipo === 'TRIPULACAO' && /^Sa[ií]da/i.test(o.movimento || '') && !o.horaRetorno && mesmoNavio(o.navio, r.navio))
                    .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''))[0];
                if (!saida) continue;
                registrarHistorico(saida, { horaRetorno: r.horaInicial || item.hora }, 'Retorno informado no grupo');
                saida.horaRetorno = r.horaInicial || item.hora;
                await alterarFicha(f => linhaDoNavio(f, saida));
                fechadas++;
            }
            await salvarOperacoes();
            item.status = fechadas ? 'usado' : 'pendente';
            item.destino = fechadas ? 'Retorno dos tripulantes registrado (automático)' : '⚠️ A confirmar: retorno de tripulantes sem saída a passeio em aberto para este navio';
            salvarEntradaDepois();
            return;
        }

        // dúvida não vira operação sozinha: fica "a confirmar" com o motivo
        const duvidas = [...new Set(item.rascunhos.flatMap(r => r.conferir || []))];
        if (duvidas.length) {
            item.status = 'pendente';
            item.destino = '⚠️ A confirmar: ' + duvidas.join(' | ');
            salvarEntradaDepois();
            return;
        }

        const abertas = estado.operacoes.filter(o => !o.horaFinal);
        const criar = [];
        let saidas = 0;
        for (const r of item.rascunhos) {
            const aberta = r.placa && abertas.find(o => mesmaPlaca(o.placa, r.placa) && mesmoNavio(o.navio, r.navio));
            if (aberta && (r.horaFinal || ehSaida)) {
                await registrarSaida(aberta.id, r.horaFinal || item.campos?.hora || item.hora, null);
                saidas++;
            } else if (!ehSaida || r.horaFinal) {
                const igual = operacaoParecida(r, item);
                if (igual) {
                    item.status = 'pendente';
                    item.duplicataDe = igual.id;
                    item.destino = `⚠️ Possível duplicidade: já existe ${R.TIPOS_OPERACAO[igual.tipo]?.rotulo || 'operação'} no ${igual.navio}${igual.horaInicial ? ' (' + igual.horaInicial + 'h)' : ''} — conferir`;
                    salvarEntradaDepois();
                    return;
                }
                criar.push(r);
            }
        }
        if (criar.length) {
            const novas = await registrarOperacoes(criar, { entradaId: item.id, autor: item.autor });
            item.opIds = [...(item.opIds || []), ...novas.map(o => o.id)];
        }
        if (criar.length || saidas) {
            item.status = 'usado';
            item.destino = [criar.length ? `${criar.length > 1 ? criar.length + ' operações' : 'Operação'} de bordo` : '', saidas ? 'saída registrada' : ''].filter(Boolean).join(' + ') + ' (automático)';
            salvarEntradaDepois();
        }
        return;
    }
    if ((item.sugestao === 'SAIDA' || ehSaida) && item.campos?.placa) {
        const abertas = estado.operacoes.filter(o => !o.horaFinal && mesmaPlaca(o.placa, item.campos.placa));
        if (abertas.length) {
            for (const o of abertas) await registrarSaida(o.id, item.campos.hora || item.hora, null);
            item.status = 'usado';
            item.destino = 'Saída registrada (automático)';
            salvarEntradaDepois();
        }
    }
}

async function atualizarItemEntrada(id, { status, destino }) {
    const item = estado.entrada.find(e => e.id === id);
    if (!item) throw erro('Mensagem não encontrada.', 404);
    if (['pendente', 'usado', 'ignorado'].includes(status)) item.status = status;
    if (destino !== undefined) item.destino = destino;
    salvarEntradaDepois();
    return item;
}

// =====================================================================
// Escala (coleta desde o 1º dia) e Passagem da Escala
// =====================================================================
async function iniciarEscala(usuario) {
    if (estado.escala) await store.arquivarTurno({ tipo: 'ESCALA', ...estado.escala, data: estado.escala.dataInicio, turno: 'ESCALA' });
    const t = agora();
    estado.escala = {
        id: novoId(), iniciadaEm: t.iso, iniciadaPor: quem(usuario), dataInicio: estado.ficha.data,
        ultimoTurnoEm: t.iso, registros: [], passagem: null
    };
    estado.plantao.sugerirNovaEscala = false;
    await Promise.all([store.set('escala', estado.escala), store.set('plantao', estado.plantao)]);
    auditar(usuario, 'Iniciou nova escala', estado.escala.dataInicio);
    return estado.escala;
}

async function continuarEscala(usuario) {
    if (!estado.escala) return iniciarEscala(usuario);
    estado.escala.ultimoTurnoEm = agora().iso;
    estado.plantao.sugerirNovaEscala = false;
    await Promise.all([store.set('escala', estado.escala), store.set('plantao', estado.plantao)]);
    return estado.escala;
}

function coletarNaEscala(f) {
    if (!estado.escala) return;
    const origem = `${(f.data || '').slice(0, 5)} ${f.turno || ''}`;
    estado.escala.registros = estado.escala.registros.filter(r => r.fichaId !== f.id);
    for (const a of f.atividades || []) estado.escala.registros.push({ id: `${f.id}:${a.id}`, fichaId: f.id, categoria: 'atividades', texto: a.texto, origem });
    for (const o of f.ocorrencias || []) estado.escala.registros.push({ id: `${f.id}:${o.id}`, fichaId: f.id, categoria: 'ocorrencias', texto: o.texto, origem });
    salvarDepois('escala', () => estado.escala, 200);
}

function textoPendencia(p) {
    const ultima = (p.historico || []).filter(h => h.tipo === 'ATUALIZACAO').slice(-1)[0];
    let t = p.titulo || '';
    if (p.texto) t += (t ? ': ' : '') + p.texto.replace(/\n+/g, ' ');
    if (ultima) t += ` (Atualização ${ultima.data} ${ultima.hora}h: ${ultima.texto})`;
    return t;
}

function construirPassagem() {
    const e = estado.escala;
    const f = estado.ficha;
    const semHora = s => limparMarcador(String(s || '').replace(/^\s*\d{1,2}:\d{2}h?\s*[-–]?\s*/, ''));
    const norm = s => semAcento(semHora(s)).toLowerCase().replace(/[^a-z0-9]/g, '');
    const daEscala = cat => {
        const atuais = (f[cat] || []).map(i => ({ chave: `${f.id}:${i.id}`, texto: i.texto, origem: `${(f.data || '').slice(0, 5)} ${f.turno}` }));
        const todos = [...(e?.registros || []).filter(r => r.categoria === cat).map(r => ({ chave: r.id, texto: r.texto, origem: r.origem })), ...atuais];
        const vistos = new Set();
        return todos.filter(i => { const k = norm(i.texto); if (!k || vistos.has(k)) return false; vistos.add(k); return true; })
            .map(i => ({ ...i, texto: semHora(i.texto) }));
    };
    const gerado = {
        digital: estado.pendencias.filter(p => p.tipo === 'DIGITAL' && p.status === 'ABERTA').map(p => ({ chave: `p:${p.id}`, texto: textoPendencia(p), origem: 'Pendência' })),
        avisos: estado.pendencias.filter(p => p.tipo === 'AVISO' && p.status === 'ABERTA').map(p => ({ chave: `p:${p.id}`, texto: textoPendencia(p), origem: 'Pendência' })),
        ocorrencias: daEscala('ocorrencias'),
        atividades: daEscala('atividades')
    };
    const salvo = e?.passagem;
    const secoes = {};
    for (const sec of Object.keys(gerado)) {
        const itensSalvos = salvo?.secoes?.[sec] || [];
        const chaves = new Set(itensSalvos.map(i => i.chave).filter(Boolean));
        const removidos = new Set(salvo?.removidos || []);
        const novos = gerado[sec].filter(i => !chaves.has(i.chave) && !removidos.has(i.chave)).map(i => ({ ...i, id: novoId(), novo: !!salvo }));
        secoes[sec] = [...itensSalvos, ...novos];
    }
    const inicio = e?.dataInicio || f.data;
    return {
        escala: e ? { id: e.id, dataInicio: e.dataInicio, iniciadaPor: e.iniciadaPor, iniciadaEm: e.iniciadaEm } : null,
        periodo: inicio === f.data ? f.data : `${inicio} a ${f.data}`,
        secoes, editadoEm: salvo?.editadoEm || null, removidos: salvo?.removidos || []
    };
}

async function salvarPassagem({ secoes, removidos }, usuario) {
    if (!estado.escala) throw erro('Inicie uma escala primeiro.', 409);
    const limpar = arr => (arr || []).map(i => ({ id: i.id || novoId(), chave: i.chave || null, texto: String(i.texto || '').trim(), origem: i.origem || 'Manual' })).filter(i => i.texto);
    estado.escala.passagem = {
        secoes: { digital: limpar(secoes.digital), avisos: limpar(secoes.avisos), ocorrencias: limpar(secoes.ocorrencias), atividades: limpar(secoes.atividades) },
        removidos: [...new Set(removidos || [])], editadoEm: agora().iso, editadoPor: quem(usuario)
    };
    await store.set('escala', estado.escala);
    return construirPassagem();
}

async function restaurarPassagem(usuario) {
    if (estado.escala) { estado.escala.passagem = null; await store.set('escala', estado.escala); }
    auditar(usuario, 'Restaurou a passagem da escala');
    return construirPassagem();
}

function textoPassagem({ negrito = true } = {}) {
    const p = construirPassagem();
    return R.formatarPassagemEscala(p.periodo, p.secoes, { negrito });
}

module.exports = {
    estado, carregar, aoAlerta, aoMudarPlantao, aoPrecisarMinutaWhatsapp, auditar, minutasPendentes,
    salvarConfig, liderDePlantao, assumirPlantao, nomesDaEquipe, adicionarNomeEquipe, removerNomeEquipe,
    salvarFicha, herdar, novaFichaEmBranco, marcarPublicado, textoRelatorio, conferencia, avisosAbertos, operacoesDaFicha,
    registrarRelatorio, dispensarRelatorioPendente, aposPublicar, equipeDoUsuario, salvarEquipe, excluirEquipe,
    arquivarRelatorio, historicoOrdenado, importarMensagens, herdarDoHistorico,
    criarPendencia, atualizarPendencia, editarPendencia, concluirPendencia, reabrirPendencia, excluirPendencia,
    registrarOperacoes, registrarSaida, atualizarOperacao, excluirOperacao, enviarEmailOperacao, marcarEmailOperacao, destinatarioEmail,
    receberMensagem, atualizarItemEntrada,
    iniciarEscala, continuarEscala, construirPassagem, salvarPassagem, restaurarPassagem, textoPassagem
};

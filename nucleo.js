// =====================================================================
// NÚCLEO: estado do sistema (configuração, ficha do turno, caixa de
// entrada e último relatório da US) e as regras que mexem nele.
// =====================================================================
const store = require('./store');
const R = require('./relatorio');
const { agora, semAcento } = require('./util');

const LIMITE_ENTRADA = 400;

const CONFIG_PADRAO = {
    gruposMonitorados: [],          // IDs dos grupos que o robô lê (nenhum = não lê nada)
    nomesGrupos: {},                // id -> nome (para exibir)
    grupoPublicacao: '',            // onde o relatório é publicado
    alertaNumero: '',               // número que recebe alerta de emergência (só dígitos com 55)
    alertasAtivos: true,
    emailDestinatarios: '',
    emailCopia: '',
    vtrModelo: 'L200',
    vtrPlaca: 'TDG-8C89',
    atividadesBase: [
        'Realizadas atividades administrativas.',
        'Executada ronda em todo o terminal, com apoio do Supervisor Sunset.'
    ],
    ultimoTextoPublicado: ''
};

const estado = {
    config: null,
    ficha: null,
    entrada: [],
    relatorioUS: null,
    versao: 0
};

let alertaHandler = null;
let timerEntrada = null;

async function carregar() {
    const cfg = await store.get('config', null);
    estado.config = { ...CONFIG_PADRAO, ...(cfg || {}) };
    if (!cfg) {
        if (process.env.WHATSAPP_NUMERO_ALERTA) estado.config.alertaNumero = process.env.WHATSAPP_NUMERO_ALERTA.replace(/\D/g, '');
        if (process.env.EMAIL_DESTINATARIOS) estado.config.emailDestinatarios = process.env.EMAIL_DESTINATARIOS;
        await store.set('config', estado.config);
    }
    estado.ficha = await store.get('ficha', null) || R.fichaVazia(estado.config);
    estado.versao = estado.ficha.versao || 0;
    estado.entrada = await store.get('entrada', []) || [];
    estado.relatorioUS = await store.get('relatorio_us', null);
}

function aoAlerta(fn) { alertaHandler = fn; }

// ------------------------- Configuração -------------------------------
async function salvarConfig(parcial) {
    const permitido = Object.keys(CONFIG_PADRAO).filter(k => k !== 'ultimoTextoPublicado');
    for (const k of permitido) if (k in parcial) estado.config[k] = parcial[k];
    estado.config.alertaNumero = String(estado.config.alertaNumero || '').replace(/\D/g, '');
    estado.config.gruposMonitorados = (estado.config.gruposMonitorados || []).filter(Boolean);
    estado.config.atividadesBase = (estado.config.atividadesBase || []).map(s => String(s).trim()).filter(Boolean);
    await store.set('config', estado.config);
    return estado.config;
}

// ------------------------- Ficha do turno -----------------------------
async function salvarFicha(ficha, versaoCliente, { substituir = false } = {}) {
    if (versaoCliente !== undefined && versaoCliente !== estado.versao) {
        const e = new Error('A ficha foi alterada em outro aparelho. Recarregue para ver a versão atual.');
        e.status = 409; throw e;
    }
    const t = agora();
    estado.versao += 1;
    const id = substituir ? ficha.id : estado.ficha.id;
    const extras = substituir ? {} : { criadoEm: estado.ficha.criadoEm, herdadoDe: estado.ficha.herdadoDe, publicadoEm: estado.ficha.publicadoEm };
    estado.ficha = { ...ficha, ...extras, id, versao: estado.versao, atualizadoEm: t.iso };
    await store.set('ficha', estado.ficha);
    return estado.ficha;
}

function fichaTemConteudo(f) {
    return f && (f.publicadoEm || f.atualizadoEm !== f.criadoEm);
}

async function herdar() {
    if (!estado.relatorioUS) {
        const e = new Error('Nenhum relatório da US foi capturado ainda. Use "Colar relatório".'); e.status = 404; throw e;
    }
    if (fichaTemConteudo(estado.ficha)) await store.arquivarTurno(estado.ficha);
    const nova = R.fichaHerdada(estado.relatorioUS, estado.ficha, estado.config);
    estado.relatorioUS.herdadoEm = agora().iso;
    await store.set('relatorio_us', estado.relatorioUS);
    return salvarFicha(nova, undefined, { substituir: true });
}

async function novaFichaEmBranco() {
    if (fichaTemConteudo(estado.ficha)) await store.arquivarTurno(estado.ficha);
    const nova = R.fichaVazia(estado.config);
    nova.avisos = estado.ficha?.avisos || [];
    nova.vtr.kmInicial = nova.vtr.kmFinal = estado.ficha?.vtr?.kmFinal ?? null;
    return salvarFicha(nova, undefined, { substituir: true });
}

async function marcarPublicado(texto) {
    estado.config.ultimoTextoPublicado = semAcento(texto).replace(/\W/g, '').slice(0, 500);
    await store.set('config', estado.config);
    estado.ficha.publicadoEm = agora().iso;
    await store.set('ficha', estado.ficha);
}

// ------------------------- Relatório da US ----------------------------
function ehNossoProprioRelatorio(texto, lido) {
    const assinatura = semAcento(texto).replace(/\W/g, '').slice(0, 500);
    if (assinatura && assinatura === estado.config.ultimoTextoPublicado) return true;
    const f = estado.ficha;
    return !!(f && lido.dados.data === f.data && lido.dados.turno === f.turno);
}

async function registrarRelatorioUS({ texto, autor, grupoNome, chatId, manual = false }) {
    const lido = R.lerRelatorio(texto);
    estado.relatorioUS = {
        texto, autor: autor || '', grupoNome: grupoNome || '', chatId: chatId || '',
        manual, capturadoEm: agora().iso, herdadoEm: null, ...lido
    };
    await store.set('relatorio_us', estado.relatorioUS);
    console.log(`📑 [RELATÓRIO US] ${manual ? 'Colado manualmente' : 'Capturado de ' + autor} • ${lido.dados.data || '?'} ${lido.dados.turno || ''} • faltando: ${lido.faltando.join(', ') || 'nada'}`);
    return estado.relatorioUS;
}

// ------------------------- Caixa de entrada ---------------------------
function salvarEntradaDepois() {
    clearTimeout(timerEntrada);
    timerEntrada = setTimeout(() => store.set('entrada', estado.entrada).catch(e => console.error('Erro ao salvar entrada:', e.message)), 1500);
}

async function receberMensagem(msg) {
    // msg: { id, chatId, grupoNome, autor, texto, timestamp, fromMe, historico }
    if (!estado.config.gruposMonitorados.includes(msg.chatId)) return;
    if (!msg.texto || !msg.texto.trim()) return;
    if (estado.entrada.some(e => e.id === msg.id)) return;

    // Mensagem editada no WhatsApp: atualiza o item original (se ainda não foi tratado)
    if (msg.editaId) {
        const original = estado.entrada.find(e => e.id === msg.editaId);
        if (original && !R.ehRelatorioDeTurno(msg.texto)) {
            const c = R.classificarMensagem(msg.texto);
            Object.assign(original, { texto: msg.texto.trim(), editado: true, campos: c.campos, urgente: c.urgente });
            if (original.status !== 'usado') { original.sugestao = c.sugestao; original.status = c.ruido ? 'ignorado' : 'pendente'; }
            salvarEntradaDepois();
            return;
        }
    }

    if (R.ehRelatorioDeTurno(msg.texto)) {
        const lido = R.lerRelatorio(msg.texto);
        if (msg.fromMe || ehNossoProprioRelatorio(msg.texto, lido)) return;
        const atualTs = estado.relatorioUS?.mensagemTs || 0;
        if (msg.timestamp >= atualTs) {
            await registrarRelatorioUS({ texto: msg.texto, autor: msg.autor, grupoNome: msg.grupoNome, chatId: msg.chatId });
            estado.relatorioUS.mensagemTs = msg.timestamp;
            await store.set('relatorio_us', estado.relatorioUS);
        }
        return;
    }

    const c = R.classificarMensagem(msg.texto);
    const t = agora(new Date(msg.timestamp || Date.now()));
    const item = {
        id: msg.id, chatId: msg.chatId, grupoNome: msg.grupoNome || '', autor: msg.autor || '',
        texto: msg.texto.trim(), ts: msg.timestamp || Date.now(), data: t.data, hora: t.hora,
        fromMe: !!msg.fromMe, sugestao: c.sugestao, urgente: c.urgente, campos: c.campos,
        status: c.ruido ? 'ignorado' : 'pendente', destino: null
    };
    estado.entrada.push(item);
    estado.entrada.sort((a, b) => a.ts - b.ts);
    if (estado.entrada.length > LIMITE_ENTRADA) {
        // descarta primeiro os mais antigos já tratados
        const excesso = estado.entrada.length - LIMITE_ENTRADA;
        let removidos = 0;
        estado.entrada = estado.entrada.filter(e => (removidos < excesso && e.status !== 'pendente') ? (removidos++, false) : true);
        if (estado.entrada.length > LIMITE_ENTRADA) estado.entrada = estado.entrada.slice(-LIMITE_ENTRADA);
    }
    salvarEntradaDepois();

    const recente = Date.now() - item.ts < 30 * 60 * 1000;
    if (item.urgente && recente && !msg.historico && alertaHandler && estado.config.alertasAtivos && estado.config.alertaNumero) {
        alertaHandler(item);
    }
}

async function atualizarItemEntrada(id, { status, destino }) {
    const item = estado.entrada.find(e => e.id === id);
    if (!item) { const e = new Error('Mensagem não encontrada.'); e.status = 404; throw e; }
    if (['pendente', 'usado', 'ignorado'].includes(status)) item.status = status;
    if (destino !== undefined) item.destino = destino;
    salvarEntradaDepois();
    return item;
}

module.exports = {
    estado, carregar, aoAlerta, salvarConfig, salvarFicha, herdar, novaFichaEmBranco,
    marcarPublicado, registrarRelatorioUS, receberMensagem, atualizarItemEntrada
};

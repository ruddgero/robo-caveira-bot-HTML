// =====================================================================
// PLANILHA DE CONTROLE DE NAVIOS (T-ORE e T-OIL)
// - Uma linha por estadia do navio (atracação → desatracação), no bloco do mês da atracação
// - Alimentada SÓ pelo que foi validado no relatório publicado (manobras da seção 6 + operações do turno)
// - Valores acumulados da estadia: é só colar a linha por cima da linha do departamento
// =====================================================================
const R = require('./relatorio');
const { semAcento, normalizarHora, diaSeguinte, novoId, agora } = require('./util');

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// ---------------------------------------------------------------------
// Manobras escritas na seção 6 ("Atracado às 10:42", "Desatracado em 19/11 às 12:25")
// ---------------------------------------------------------------------
function dataCompleta(txt, ficha) {
    const m = String(txt || '').match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) return '';
    const ano = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(ficha?.data || '').slice(6) || String(new Date().getFullYear());
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${ano}`;
}

function lerManobra(linha, ficha = {}) {
    const n = semAcento(R.ehSemAlteracao(linha) ? '' : linha).toLowerCase();
    if (!n || /previs|programad|\beta\b|\betb\b|\betd\b|aguardando|em manobra|manobra de/.test(n)) return null;
    let tipo = null;
    if (/\bdesatraca(d[oa]|cao|ou|r)\b/.test(n)) tipo = 'DESATRACACAO';
    else if (/\batraca(d[oa]|cao|ou|r)\b/.test(n)) tipo = 'ATRACACAO';
    else if (/\bfunde(ad[oa]|io|ou)\b/.test(n)) tipo = 'FUNDEIO';
    if (!tipo) return null;
    const hora = normalizarHora(linha);
    let data = dataCompleta(linha, ficha);
    if (!data) {
        data = ficha.data || agora().data;
        // turno noturno: depois da meia-noite já é o dia seguinte
        if (ficha.turno === 'NOTURNO' && hora && hora < '07:00') data = diaSeguinte(data);
    }
    return { tipo, data, hora };
}

// ---------------------------------------------------------------------
// O que cada operação soma na linha do navio
// ---------------------------------------------------------------------
function q(v) { return parseInt(String(v || '').replace(/\D/g, ''), 10) || 0; }

function contribuicao(op) {
    const c = { rancho: 0, peca: 0, embarque: 0, desembarque: 0, passeio: 0, caixa: { LE: 0, LB: 0, OE: 0, OB: 0 }, obs: [] };
    switch (op.tipo) {
        case 'RANCHO': c.rancho = 1; break;
        case 'MATERIAIS': c.peca = 1; break;
        case 'DTA': c.peca = 1; c.obs.push('DTA'); break;          // DTA entra como Peça
        case 'AGUA': c.obs.push('Água potável'); break;
        case 'COMBUSTIVEL': c.obs.push('Abastecimento de combustível'); break;
        case 'RESIDUOS': c.obs.push('Retirada de resíduos'); break;
        case 'K9': c.obs.push('K9'); break;
        case 'LACRE': c.obs.push('Lacre / deslacração'); break;
        case 'MERGULHO': {
            const lado = (op.berco === 'LESTE' ? 'L' : op.berco === 'OESTE' ? 'O' : '') + (op.bordo === 'E' || op.bordo === 'B' ? op.bordo : '');
            if (lado.length === 2) c.caixa[lado] = 1;
            c.obs.push('Inspeção caixa de mar');
            break;
        }
        case 'TRIPULACAO': {
            const mov = semAcento(op.movimento || '').toUpperCase();
            if (op.qtdEmbarque || op.qtdDesembarque) { c.embarque = q(op.qtdEmbarque); c.desembarque = q(op.qtdDesembarque); }
            else if (/^SAIDA/.test(mov)) { c.passeio = q(op.quantidade) || 1; if (/MEDIC|HOSPITAL/.test(mov)) c.obs.push('Atendimento médico'); }
            else if (/^DESEMBARQUE/.test(mov)) c.desembarque = q(op.quantidade) || 1;
            else if (/^EMBARQUE E DESEMBARQUE/.test(mov)) { c.embarque = q(op.quantidade); }
            else if (/^EMBARQUE/.test(mov)) c.embarque = q(op.quantidade) || 1;
            if (/DEFINITIV/.test(mov)) c.obs.push(op.movimento);
            break;
        }
        case 'OUTRA': c.obs.push(op.observacoes ? String(op.observacoes).slice(0, 60) : 'Operação de bordo'); break;
        default: break;
    }
    return c;
}

// ---------------------------------------------------------------------
// Valores da linha (acumulados da estadia)
// ---------------------------------------------------------------------
function valores(e) {
    const v = { navio: e.navio, atracData: e.atracacao?.data || '', atracHora: e.atracacao?.hora || '', desatracData: e.desatracacao?.data || '',
        desatracHora: e.desatracacao?.hora || '', rancho: 0, peca: 0, embarque: 0, desembarque: 0, passeio: 0, LE: 0, LB: 0, OE: 0, OB: 0, obs: '' };
    const obs = [...(e.obs || [])];
    for (const c of Object.values(e.contribuicoes || {})) {
        for (const k of ['rancho', 'peca', 'embarque', 'desembarque', 'passeio']) v[k] += c[k] || 0;
        for (const k of ['LE', 'LB', 'OE', 'OB']) v[k] += c.caixa?.[k] || 0;
        obs.push(...(c.obs || []));
    }
    v.obs = [...new Set(obs.filter(Boolean).map(x => String(x).trim()))].join(' / ');
    return v;
}

function mesDaEstadia(e) {
    const d = e.atracacao?.data || e.primeiroRegistro || '';
    const m = parseInt(d.slice(3, 5), 10);
    return m ? { mes: m, ano: d.slice(6), nome: MESES[m - 1] } : { mes: 0, ano: '', nome: '' };
}

// ---------------------------------------------------------------------
// Atualiza as estadias com o turno publicado
// ---------------------------------------------------------------------
function acharEstadia(estadias, terminal, navio, { abertaApenas = true } = {}) {
    const k = R.chaveNavio(navio);
    return estadias
        .filter(e => e.terminal === terminal && R.chaveNavio(e.navio) === k && (!abertaApenas || !e.desatracacao))
        .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)))[0] || null;
}

// parcial = o robô começou a acompanhar o navio com ele já atracado: os números são só do que o robô viu
function novaEstadia(estadias, terminal, navio, data, parcial = true) {
    const e = { id: novoId(), terminal, navio: R.nomeNavioLimpo(navio), atracacao: null, desatracacao: null, obs: [], contribuicoes: {},
        parcial, primeiroRegistro: data, criadoEm: agora().iso, atualizadoEm: agora().iso };
    estadias.push(e);
    return e;
}

function diasEntre(a, b) {
    const p = d => { const [dd, mm, aa] = d.split('/').map(Number); return Date.UTC(aa, mm - 1, dd); };
    try { return Math.abs(p(a) - p(b)) / 864e5; } catch (_) { return 99; }
}

// ficha: a ficha publicada; ops: operações registradas neste turno
function atualizarEstadias(estadias, ficha, ops) {
    const antes = new Map(estadias.map(e => [e.id, JSON.stringify(valores(e))]));
    const tocadas = new Set(), novas = new Set();
    const tocar = e => { tocadas.add(e.id); e.atualizadoEm = agora().iso; };
    const garantir = (terminal, navio, data) => {
        let e = acharEstadia(estadias, terminal, navio);
        if (!e) { e = novaEstadia(estadias, terminal, navio, data); novas.add(e.id); }
        return e;
    };

    // 1) manobras da seção 6
    for (const [chave, terminal] of [['tore', 'T-ORE'], ['toil', 'T-OIL']]) {
        for (const n of ficha.navios?.[chave] || []) {
            if (!n.navio) continue;
            // "Previsão de desatracação às 11:30; desatracado às 12:25": cada parte é lida separada
            for (const linha of (n.linhas || []).flatMap(l => String(l).split(/\s*;\s*/))) {
                const m = lerManobra(linha, ficha);
                if (!m) continue;
                if (m.tipo === 'ATRACACAO') {
                    let e = acharEstadia(estadias, terminal, n.navio);
                    if (e && e.atracacao && (e.atracacao.data !== m.data || e.atracacao.hora !== m.hora) && diasEntre(e.atracacao.data, m.data) > 2) e = null; // outra estadia
                    if (!e) {
                        // atracou neste turno (ou no anterior): o robô acompanha a estadia inteira
                        const recente = diasEntre(m.data, ficha.data || m.data) <= 1;
                        e = novaEstadia(estadias, terminal, n.navio, m.data, !recente); novas.add(e.id);
                    }
                    if (!e.atracacao || e.atracacao.data !== m.data || e.atracacao.hora !== m.hora) { e.atracacao = { data: m.data, hora: m.hora }; tocar(e); }
                } else if (m.tipo === 'DESATRACACAO') {
                    let e = acharEstadia(estadias, terminal, n.navio);
                    if (!e) {
                        const ja = acharEstadia(estadias, terminal, n.navio, { abertaApenas: false });
                        if (ja?.desatracacao?.data === m.data) e = ja;      // a mesma linha herdada no turno seguinte
                    }
                    if (!e) { e = novaEstadia(estadias, terminal, n.navio, m.data); novas.add(e.id); }
                    if (!e.desatracacao || e.desatracacao.data !== m.data || e.desatracacao.hora !== m.hora) { e.desatracacao = { data: m.data, hora: m.hora }; tocar(e); }
                } else if (m.tipo === 'FUNDEIO') {
                    const e = garantir(terminal, n.navio, m.data);
                    if (!e.obs.includes('FUNDEIO')) { e.obs.push('FUNDEIO'); tocar(e); }
                }
            }
        }
    }

    // 2) operações do turno (cada operação soma uma vez; se foi corrigida, o valor é refeito)
    for (const o of ops || []) {
        if (!o.navio || !o.terminal || (o.conferir || []).length) continue;
        const ja = estadias.find(e => e.contribuicoes?.[o.id]);
        // navio que desatracou neste turno: a operação ainda é da estadia que acabou de fechar
        const fechada = !ja && !acharEstadia(estadias, o.terminal, o.navio) ? acharEstadia(estadias, o.terminal, o.navio, { abertaApenas: false }) : null;
        const recemFechada = fechada?.desatracacao && diasEntre(fechada.desatracacao.data, o.data || ficha.data) <= 1 ? fechada : null;
        const e = ja || recemFechada || garantir(o.terminal, o.navio, o.data || ficha.data);
        const c = contribuicao(o);
        if (JSON.stringify(e.contribuicoes[o.id] || null) !== JSON.stringify(c)) { e.contribuicoes[o.id] = c; tocar(e); }
    }

    // 3) o que mudou em cada linha (para destacar em amarelo)
    const linhas = [];
    for (const e of estadias.filter(x => tocadas.has(x.id) || novas.has(x.id))) {
        const depois = valores(e);
        const anterior = antes.has(e.id) ? JSON.parse(antes.get(e.id)) : null;
        const mudou = Object.keys(depois).filter(k => !anterior || String(anterior[k] ?? '') !== String(depois[k] ?? '')).filter(k => k !== 'navio' || !anterior);
        if (!novas.has(e.id) && !mudou.length) continue;
        linhas.push({ estadiaId: e.id, terminal: e.terminal, nova: novas.has(e.id) && !e.parcial, parcial: !!e.parcial, mes: mesDaEstadia(e), valores: depois, mudou });
    }
    linhas.sort((a, b) => a.terminal.localeCompare(b.terminal) || (a.mes.mes - b.mes.mes) || String(a.valores.atracData).localeCompare(String(b.valores.atracData)));
    return linhas;
}

function resumoTurno(linhas, ops) {
    const r = {};
    for (const t of ['T-ORE', 'T-OIL']) {
        const ls = linhas.filter(l => l.terminal === t);
        const os = (ops || []).filter(o => o.terminal === t && !(o.conferir || []).length);
        const soma = k => os.reduce((s, o) => s + (contribuicao(o)[k] || 0), 0);
        r[t] = {
            atracacoes: ls.filter(l => (l.mudou.includes('atracHora') || l.mudou.includes('atracData')) && l.valores.atracData).length,
            desatracacoes: ls.filter(l => (l.mudou.includes('desatracHora') || l.mudou.includes('desatracData')) && l.valores.desatracData).length,
            rancho: soma('rancho'), peca: soma('peca'), embarque: soma('embarque'), desembarque: soma('desembarque'), passeio: soma('passeio'),
            caixaMar: os.filter(o => o.tipo === 'MERGULHO').length, linhasNovas: ls.filter(l => l.nova).length,
            linhasAtualizar: ls.filter(l => !l.nova && !l.parcial).length, linhasSomar: ls.filter(l => l.parcial).length
        };
    }
    r.foraDaPlanilha = (ops || []).filter(o => (o.conferir || []).length).length;
    return r;
}

// ---------------------------------------------------------------------
// Excel no layout das planilhas do departamento (mesmas colunas e mesclagens)
// ---------------------------------------------------------------------
const LARGURAS = { A: 2.5, B: 5.2, C: 5.2, D: 5.2, E: 5.2, F: 5.2, G: 5.2, H: 5.2, I: 5.2, J: 5.2, K: 4.5, L: 6.8, M: 5.8, N: 4.2, O: 5.2, P: 6.8, Q: 5.2, R: 5.2, S: 2.0, T: 5.2, U: 5.2, V: 4.2, W: 5.2, X: 5.8, Y: 6.5, Z: 6.8, AA: 4.2, AB: 7.8 };

function serialData(d) {
    const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return Math.round((Date.UTC(+m[3], +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 864e5);
}
function serialHora(h) {
    const m = String(h || '').match(/^(\d{2}):(\d{2})$/);
    return m ? (+m[1] * 60 + +m[2]) / 1440 : null;
}

function abaTerminal(terminal, linhas, cab) {
    const tore = terminal === 'T-ORE';
    const fimObs = tore ? 'AO' : 'AK', iniObs = tore ? 'AG' : 'AC';
    const colInfo = tore ? 'AQ' : 'AM';
    const celulas = [], merges = [];
    const put = (ref, v, est) => celulas.push([ref, v, est]);
    const mg = r => merges.push(r);

    put('B1', `PLANILHA DE CONTROLE DE NAVIOS - ${terminal} · ${cab.turno} ${cab.data}`, 'titulo');
    put('B2', 'Copie as colunas B até ' + fimObs + ' de cada linha e cole na linha do navio, no mês indicado. Amarelo = mudou neste turno. Os valores já são o total da estadia.', 'nota');
    mg(`B1:${fimObs}1`); mg(`B2:${fimObs}2`);

    // cabeçalho igual ao do departamento (linhas 4 a 6)
    put('B4', 'NOME DO NAVIO', 'cab'); mg('B4:H6');
    put('I4', 'DATAS DAS MANOBRAS', 'cab'); mg('I4:P4');
    put('Q4', 'FORNECIMENTO DE BORDO', 'cab'); mg('Q4:V4');
    put('W4', 'MOVIMENTAÇÃO DE TRIPULANTES', 'cab'); mg('W4:AB4');
    put('I5', 'ATRACAÇÃO', 'cab'); mg('I5:K6'); put('L5', 'HORA', 'cab'); mg('L5:L6');
    put('M5', 'DESATRACAÇÃO', 'cab'); mg('M5:O6'); put('P5', 'HORA', 'cab'); mg('P5:P6');
    put('Q5', 'RANCHO', 'cab'); mg('Q5:S6'); put('T5', 'PEÇA', 'cab'); mg('T5:V6');
    put('W5', 'EMBARQUE', 'cab'); mg('W5:X6'); put('Y5', 'DESEMBARQUE', 'cab'); mg('Y5:Z6');
    put('AA5', 'PASSEIO / ATENDIMENTO MÉDICO', 'cab'); mg('AA5:AB6');
    if (tore) {
        put('AC4', 'CAIXA DE MAR', 'cab'); mg('AC4:AF4');
        put('AC5', 'LESTE', 'cab'); mg('AC5:AD5'); put('AE5', 'OESTE', 'cab'); mg('AE5:AF5');
        put('AC6', 'E', 'cab'); put('AD6', 'B', 'cab'); put('AE6', 'E', 'cab'); put('AF6', 'B', 'cab');
    }
    put(`${iniObs}4`, 'OBSERVAÇÕES', 'cab'); mg(`${iniObs}4:${fimObs}6`);
    put(`${colInfo}4`, 'MÊS / O QUE FAZER', 'cab'); mg(`${colInfo}4:${colInfo}6`);

    let r = 7;
    if (!linhas.length) { put(`B${r}`, 'Nenhuma movimentação neste terminal no turno.', 'nota'); mg(`B${r}:${fimObs}${r}`); }
    for (const l of linhas) {
        const v = l.valores, mud = new Set(l.mudou);
        const est = (k, base) => (l.nova || mud.has(k) ? base + 'Am' : base);
        put(`B${r}`, v.navio, est('navio', 'esq')); mg(`B${r}:H${r}`);
        put(`I${r}`, serialData(v.atracData) ?? v.atracData, est('atracData', 'data')); mg(`I${r}:K${r}`);
        put(`L${r}`, serialHora(v.atracHora) ?? v.atracHora, est('atracHora', 'hora'));
        put(`M${r}`, serialData(v.desatracData) ?? v.desatracData, est('desatracData', 'data')); mg(`M${r}:O${r}`);
        put(`P${r}`, serialHora(v.desatracHora) ?? v.desatracHora, est('desatracHora', 'hora'));
        put(`Q${r}`, v.rancho, est('rancho', 'num')); mg(`Q${r}:S${r}`);
        put(`T${r}`, v.peca, est('peca', 'num')); mg(`T${r}:V${r}`);
        put(`W${r}`, v.embarque, est('embarque', 'num')); mg(`W${r}:X${r}`);
        put(`Y${r}`, v.desembarque, est('desembarque', 'num')); mg(`Y${r}:Z${r}`);
        put(`AA${r}`, v.passeio, est('passeio', 'num')); mg(`AA${r}:AB${r}`);
        if (tore) { put(`AC${r}`, v.LE, est('LE', 'num')); put(`AD${r}`, v.LB, est('LB', 'num')); put(`AE${r}`, v.OE, est('OE', 'num')); put(`AF${r}`, v.OB, est('OB', 'num')); }
        put(`${iniObs}${r}`, v.obs, est('obs', 'esq')); mg(`${iniObs}${r}:${fimObs}${r}`);
        put(`${colInfo}${r}`, `${l.mes.nome || 'MÊS DA ATRACAÇÃO'} · ${l.parcial ? 'CONFERIR: o robô não viu a estadia inteira, some aos números que já estão na planilha' : l.nova ? 'NOVA LINHA' : 'ATUALIZAR LINHA (colar por cima)'}`, l.nova ? 'infoNova' : 'info');
        r++;
    }
    const larguras = { ...LARGURAS, [colInfo]: 60 };
    if (tore) Object.assign(larguras, { AC: 5.2, AD: 5.2, AE: 5.2, AF: 5.2 });
    return { nome: terminal, celulas, merges, larguras };
}

function abaResumo(pub) {
    const r = pub.resumo || {};
    const L = (t, k) => [t, r['T-ORE']?.[k] ?? 0, r['T-OIL']?.[k] ?? 0];
    return {
        nome: 'Resumo', cabecalho: false, larguras: [42, 12, 12],
        linhas: [
            { titulo: `RESUMO DO TURNO · ${pub.turno} ${pub.data}`, grande: true },
            [],
            { titulo: 'Totais do turno' },
            ['', 'T-ORE', 'T-OIL'],
            L('Atracações registradas', 'atracacoes'), L('Desatracações registradas', 'desatracacoes'),
            L('Rancho', 'rancho'), L('Peça / DTA', 'peca'),
            L('Tripulantes embarcados', 'embarque'), L('Tripulantes desembarcados', 'desembarque'), L('Passeio / atendimento médico', 'passeio'),
            L('Inspeção caixa de mar', 'caixaMar'),
            [],
            { titulo: 'Linhas para colar' },
            L('Linhas novas', 'linhasNovas'), L('Linhas para atualizar (colar por cima)', 'linhasAtualizar'), L('Linhas para conferir e somar', 'linhasSomar'),
            [],
            r.foraDaPlanilha ? ['Operações com pendência de conferência (não entraram)', r.foraDaPlanilha, ''] : ['Todas as operações validadas entraram na planilha.', '', ''],
            ['Gerado em', pub.geradoEm || '', '']
        ]
    };
}

function abasPlanilha(pub) {
    return [abaResumo(pub), abaTerminal('T-ORE', pub.linhas.filter(l => l.terminal === 'T-ORE'), pub), abaTerminal('T-OIL', pub.linhas.filter(l => l.terminal === 'T-OIL'), pub)];
}

module.exports = { lerManobra, contribuicao, valores, atualizarEstadias, resumoTurno, abasPlanilha, serialData, serialHora, MESES };

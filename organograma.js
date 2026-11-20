// =====================================================================
// ORGANOGRAMA OPERACIONAL + ESCALA 4×4 + SUBSTITUIÇÕES
// - Equipes de rodízio: Amarela → Azul → Verde → Branca (2 diurnos, 2 noturnos, 4 folgas)
// - Feristas: fora do rodízio, primeira opção para cobrir férias/folgas
// - Substituição só entre o mesmo cargo (líder ↔ líder, operador ↔ operador)
// =====================================================================
const { novoId, semAcento, agora } = require('./util');

const CARGOS = { LIDER: 'Líder de turno', OPERADOR: 'Operador de CCOS' };

// Quadro inicial (organograma da Segurança Patrimonial · só operacionais)
function quadroInicial() {
    const p = (nome, cargo, base, funcao) => ({ id: novoId(), nome, cargo, base, funcao: funcao || CARGOS[cargo] });
    return [
        { id: 'AMARELA', nome: 'Equipe Amarela', cor: 'amarela', rodizio: true, membros: [p('Renan Neves', 'LIDER', 'SJB'), p('Mariana Freitas', 'OPERADOR', 'Campos', 'Operadora de CCOS'), p('Ewerton Brito', 'OPERADOR', 'Campos')] },
        { id: 'AZUL', nome: 'Equipe Azul', cor: 'azul', rodizio: true, membros: [p('Ruddgero Ribeiro', 'LIDER', 'SJB'), p('Felipe Furtado', 'OPERADOR', 'Campos'), p('Laís Campos', 'OPERADOR', 'Campos', 'Operadora de CCOS')] },
        { id: 'BRANCA', nome: 'Equipe Branca', cor: 'branca', rodizio: true, membros: [p('Gustavo Ramos', 'LIDER', 'SJB'), p('Rodrigo Chaves', 'OPERADOR', 'Campos'), p('Ítalo Nunes', 'OPERADOR', 'Campos')] },
        { id: 'VERDE', nome: 'Equipe Verde', cor: 'verde', rodizio: true, membros: [p('Alex Gomes', 'LIDER', 'SJB'), p('Azenclévis Lucas', 'OPERADOR', 'Campos'), p('Priscila Chagas', 'OPERADOR', 'Campos', 'Operadora de CCOS')] },
        { id: 'FERISTA', nome: 'Feristas', cor: 'roxa', rodizio: false, membros: [p('Wallace Chagas', 'LIDER', 'Campos', 'Líder de turno (ferista)'), p('Marcos Duarte', 'OPERADOR', 'Campos', 'Operador de CCOS (ferista)')] }
    ];
}

// Escala 4×4: referência = 1º diurno de uma equipe. Ex.: Azul fez o 1º diurno em 19/11/2026.
const ESCALA_PADRAO = { ordem: ['AMARELA', 'AZUL', 'VERDE', 'BRANCA'], referencia: { equipe: 'AZUL', data: '19/11/2026' } };

function diaNum(dataBR) {
    const [d, m, a] = String(dataBR || '').split('/').map(Number);
    return Math.round(Date.UTC(a, m - 1, d) / 864e5);
}
function dataDe(num) {
    const dt = new Date(num * 864e5);
    return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

// Qual equipe está de serviço num turno (DIURNO/NOTURNO) de uma data
function equipeDoTurno(turno, dataBR, escala = ESCALA_PADRAO) {
    const ordem = escala.ordem || ESCALA_PADRAO.ordem;
    const ref = escala.referencia || ESCALA_PADRAO.referencia;
    const iRef = ordem.indexOf(ref.equipe);
    const base = diaNum(ref.data);
    const hoje = diaNum(dataBR);
    if (iRef < 0 || isNaN(base) || isNaN(hoje)) return null;
    for (let i = 0; i < ordem.length; i++) {
        const inicio = base + (i - iRef) * 2;                 // cada equipe começa o ciclo 2 dias depois da anterior
        const fase = (((hoje - inicio) % 8) + 8) % 8;         // 0-1 diurno · 2-3 noturno · 4-7 folga
        if ((turno === 'DIURNO' && fase <= 1) || (turno === 'NOTURNO' && (fase === 2 || fase === 3))) return ordem[i];
    }
    return null;
}
function proximoTurno(turno, dataBR) {
    return turno === 'DIURNO' ? { turno: 'NOTURNO', data: dataBR } : { turno: 'DIURNO', data: dataDe(diaNum(dataBR) + 1) };
}
// Equipes de folga num dia (para sugerir quem pode cobrir)
function equipesDeFolga(dataBR, escala = ESCALA_PADRAO) {
    const servico = new Set([equipeDoTurno('DIURNO', dataBR, escala), equipeDoTurno('NOTURNO', dataBR, escala)]);
    return (escala.ordem || ESCALA_PADRAO.ordem).filter(e => !servico.has(e));
}
function proximosDias(dataBR, dias = 8, escala = ESCALA_PADRAO) {
    const ini = diaNum(dataBR);
    return Array.from({ length: dias }, (_, k) => {
        const d = dataDe(ini + k);
        return { data: d, diurno: equipeDoTurno('DIURNO', d, escala), noturno: equipeDoTurno('NOTURNO', d, escala) };
    });
}

// ---------------------------------------------------------------------
// Substituições: { id, titularId, substitutoId, de, ate, motivo }
// ---------------------------------------------------------------------
function pessoa(org, id) {
    for (const e of org.equipes) { const m = e.membros.find(x => x.id === id); if (m) return { ...m, equipeId: e.id, equipeNome: e.nome }; }
    return null;
}
function pessoaPorNome(org, nome) {
    const k = semAcento(nome).toLowerCase().trim();
    for (const e of org.equipes) { const m = e.membros.find(x => semAcento(x.nome).toLowerCase() === k); if (m) return { ...m, equipeId: e.id, equipeNome: e.nome }; }
    return null;
}
function substituicaoAtiva(org, titularId, dataBR) {
    const d = diaNum(dataBR);
    return (org.substituicoes || []).find(s => s.titularId === titularId && diaNum(s.de) <= d && d <= diaNum(s.ate)) || null;
}
// Integrantes que de fato trabalham na equipe naquela data
function equipeEfetiva(org, equipeId, dataBR) {
    const e = org.equipes.find(x => x.id === equipeId);
    if (!e) return null;
    const membros = e.membros.map(m => {
        const s = substituicaoAtiva(org, m.id, dataBR);
        const sub = s ? pessoa(org, s.substitutoId) : null;
        return sub ? { ...sub, cobrindo: m.nome, cobrindoId: m.id, motivo: s.motivo, ate: s.ate } : { ...m };
    });
    return { id: e.id, nome: e.nome, cor: e.cor, rodizio: e.rodizio, membros, nomes: membros.map(m => m.nome) };
}
// Quem pode cobrir alguém (mesmo cargo): feristas primeiro, depois quem está de folga, depois o resto
function opcoesSubstituto(org, titularNome, dataBR, escala = ESCALA_PADRAO) {
    const t = pessoaPorNome(org, titularNome);
    const cargo = t?.cargo;
    const folga = new Set(equipesDeFolga(dataBR, escala));
    const lista = [];
    for (const e of org.equipes) {
        for (const m of e.membros) {
            if (t && m.id === t.id) continue;
            if (cargo && m.cargo !== cargo) continue;
            if (t && e.id === t.equipeId) continue;                       // colega da mesma equipe já está no turno
            if (substituicaoAtiva(org, m.id, dataBR)) continue;           // quem está de férias/folga não cobre
            const ocupado = (org.substituicoes || []).some(s => s.substitutoId === m.id && diaNum(s.de) <= diaNum(dataBR) && diaNum(dataBR) <= diaNum(s.ate));
            const ordem = !e.rodizio ? 0 : folga.has(e.id) ? 1 : 2;
            lista.push({ id: m.id, nome: m.nome, cargo: m.cargo, equipe: e.nome, situacao: !e.rodizio ? 'ferista' : folga.has(e.id) ? 'folga' : 'de serviço', ocupado, ordem });
        }
    }
    return { titular: t, opcoes: lista.sort((a, b) => a.ordem - b.ordem || a.ocupado - b.ocupado || a.nome.localeCompare(b.nome, 'pt-BR')) };
}

function novaSubstituicao(org, { titularId, substitutoId, de, ate, motivo }, usuario) {
    const t = pessoa(org, titularId), s = pessoa(org, substitutoId);
    if (!t || !s) throw Object.assign(new Error('Colaborador não encontrado no organograma.'), { status: 404 });
    if (t.cargo !== s.cargo) throw Object.assign(new Error(`${s.nome} não pode cobrir ${t.nome}: operador cobre só operador e líder cobre só líder.`), { status: 400 });
    const re = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!re.test(de) || !re.test(ate) || diaNum(ate) < diaNum(de)) throw Object.assign(new Error('Informe o período (de / até) no formato dd/mm/aaaa.'), { status: 400 });
    const nova = { id: novoId(), titularId, substitutoId, de, ate, motivo: String(motivo || 'Férias').trim(), criadoEm: agora().iso, criadoPor: usuario?.nome || '' };
    org.substituicoes = [...(org.substituicoes || []).filter(x => !(x.titularId === titularId && diaNum(x.de) <= diaNum(ate) && diaNum(de) <= diaNum(x.ate))), nova];
    return nova;
}

module.exports = { CARGOS, quadroInicial, ESCALA_PADRAO, equipeDoTurno, proximoTurno, equipesDeFolga, proximosDias, diaNum, dataDe,
    pessoa, pessoaPorNome, equipeEfetiva, opcoesSubstituto, novaSubstituicao, substituicaoAtiva };

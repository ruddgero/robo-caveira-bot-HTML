// =====================================================================
// FICHA DO TURNO: leitura do relatório da US, herança, texto oficial,
// classificação de mensagens do grupo e minutas de e-mail de bordo.
// Toda a regra de negócio do relatório fica AQUI (uma única fonte).
// =====================================================================
const { agora, turnoPelaHora, novoId, semAcento, limparMarcador } = require('./util');

const PROCEDIMENTOS_PADRAO = '(Identificação, verificação das autorizações, Check List, Briefing de segurança, inspeções, acompanhamento e monitoramento).';
const PROCEDIMENTOS_FORNECIMENTO = '(Identificação, verificação das autorizações, Check List, Briefing de segurança, conferência das Notas Fiscais, inspeções, acompanhamento e monitoramento).';

// ---------------------------------------------------------------------
// Estrutura da ficha
// ---------------------------------------------------------------------
// Data "oficial" do turno: o noturno que vira a meia-noite continua com a data em que começou
function dataDoTurno(turno, t = agora()) {
    return (turno === 'NOTURNO' && t.horaNum < 7) ? dataDeOntem(t.data) : t.data;
}

function fichaVazia(config = {}) {
    const t = agora();
    const turno = turnoPelaHora(t.horaNum);
    return {
        id: novoId(),
        turno,
        data: dataDoTurno(turno, t),
        efetivo: '✓ S/A',
        vtr: { modelo: config.vtrModelo || 'L200', placa: config.vtrPlaca || '', kmInicial: null, kmFinal: null },
        sistemas: { cftv: '', ca: '✓ S/A', ocrAssertividade: '', ocrLeituras: '' },
        atividades: (config.atividadesBase || []).map(texto => ({ id: novoId(), texto })),
        avisos: [],
        navios: { tore: '', toil: '' },
        ocorrencias: [],
        operacoes: [],
        equipes: { saindo: '', assumindo: '' },
        herdadoDe: null,
        publicadoEm: null,
        criadoEm: t.iso,
        atualizadoEm: t.iso
    };
}

// ---------------------------------------------------------------------
// Detecção e leitura do relatório postado no grupo
// ---------------------------------------------------------------------
function normalizar(linha) {
    return semAcento(String(linha || '').replace(/[*_~]/g, '')).toUpperCase().trim();
}

const SECOES = [
    { chave: 'efetivo', teste: /EFETIVO/ },
    { chave: 'vtr', teste: /VIATURA|\bVTR\b/ },
    { chave: 'sistemas', teste: /SISTEMAS/ },
    { chave: 'atividades', teste: /ATIVIDADES/ },
    { chave: 'avisos', teste: /AVISOS/ },
    { chave: 'navios', teste: /MOVIMENTACAO|NAVIOS/ },
    { chave: 'ocorrencias', teste: /OCORRENCIAS?/ },
    { chave: 'passagem', teste: /PASSAGEM/ }
];

// Cabeçalho de seção: "1. EFETIVO CCOS", "*4. ATIVIDADES REALIZADAS*", "6 - MOVIMENTAÇÃO..."
function secaoDaLinha(linha) {
    const n = normalizar(linha);
    const m = n.match(/^(\d)\s*[.\-)]\s*(.+)$/);
    if (!m || m[2].length > 60) return null;
    const s = SECOES.find(sec => sec.teste.test(m[2]));
    return s ? s.chave : null;
}

function ehRelatorioDeTurno(texto) {
    if (!texto || typeof texto !== 'string' || texto.length < 80) return false;
    const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
    const topo = linhas.slice(0, 3).map(normalizar).join(' ');
    if (!/RELATORIO (DO |DE )?TURNO/.test(topo)) return false;
    const secoes = new Set(linhas.map(secaoDaLinha).filter(Boolean));
    return secoes.size >= 4;
}

function numeroKm(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = parseInt(String(valor).replace(/\D/g, ''), 10);
    return isNaN(n) ? null : n;
}

function ehSemAlteracao(texto) {
    return /^S\s*\/?\s*A\.?$/i.test(limparMarcador(texto)) || /^SEM ALTERAC/i.test(normalizar(limparMarcador(texto)));
}

function lerRelatorio(texto) {
    const linhas = String(texto || '').replace(/\r/g, '').split('\n');
    const dados = {
        data: null, turno: null, efetivo: null,
        vtr: { modelo: null, placa: null, kmInicial: null, kmFinal: null },
        sistemas: { cftv: null, ca: null, ocrAssertividade: null, ocrLeituras: null },
        atividades: [], avisos: [],
        navios: { tore: null, toil: null },
        ocorrencias: [],
        equipes: { saindo: null, assumindo: null }
    };

    // Cabeçalho
    for (const l of linhas.slice(0, 5)) {
        const n = normalizar(l);
        const mt = n.match(/TURNO\s*[-–:]?\s*(DIURNO|NOTURNO)/);
        if (mt) dados.turno = mt[1];
        const md = l.match(/Data:?\s*(\d{2}\/\d{2}\/\d{4})/i);
        if (md) dados.data = md[1];
    }

    // Agrupa linhas por seção
    const blocos = {};
    let atual = null;
    for (const l of linhas) {
        const s = secaoDaLinha(l);
        if (s) { atual = s; blocos[s] = blocos[s] || []; continue; }
        if (atual) blocos[atual].push(l);
    }
    const limpo = arr => (arr || []).map(l => l.trim()).filter(Boolean);

    // 1. Efetivo
    if (blocos.efetivo) dados.efetivo = limpo(blocos.efetivo).join('\n') || null;

    // 2. VTR
    for (const l of limpo(blocos.vtr)) {
        const n = normalizar(l);
        let m;
        if ((m = l.match(/Ve[íi]culo:?\s*(.+)/i))) dados.vtr.modelo = m[1].trim();
        else if ((m = l.match(/Placa:?\s*(.+)/i))) dados.vtr.placa = m[1].trim();
        else if (/KM\s*INICIAL/.test(n)) dados.vtr.kmInicial = numeroKm(l.split(':').slice(1).join(':'));
        else if (/KM\s*FINAL/.test(n)) dados.vtr.kmFinal = numeroKm(l.split(':').slice(1).join(':'));
    }

    // 3. Sistemas (subtítulos CFTV / CA / OCR)
    {
        let sub = null; const partes = { cftv: [], ca: [] };
        for (const l of limpo(blocos.sistemas)) {
            const n = normalizar(l);
            if (/^CFTV\b/.test(n) && n.length < 30) { sub = 'cftv'; continue; }
            if ((/^CA\b/.test(n) || /CONTROLE DE ACESSO/.test(n)) && n.length < 40) { sub = 'ca'; continue; }
            if (/^OCR\b/.test(n) || /RECONHECIMENTO DE PLACAS/.test(n)) { sub = 'ocr'; continue; }
            if (sub === 'ocr') {
                const ma = l.match(/Assertividade:?\s*([\d.,]+\s*%?)/i);
                if (ma) dados.sistemas.ocrAssertividade = ma[1].replace(/\s/g, '').replace(/%?$/, '%');
                const ml = l.match(/leituras:?\s*([\d.]+)/i);
                if (ml) dados.sistemas.ocrLeituras = ml[1].replace(/\./g, '');
            } else if (sub) partes[sub].push(l);
        }
        if (partes.cftv.length) dados.sistemas.cftv = partes.cftv.join('\n');
        if (partes.ca.length) dados.sistemas.ca = partes.ca.join('\n');
    }

    // 4. Atividades
    dados.atividades = limpo(blocos.atividades).map(limparMarcador).filter(t => t && !ehSemAlteracao(t));

    // 5. Avisos ("5.1. TÍTULO" + descrição)
    {
        let av = null;
        for (const l of limpo(blocos.avisos)) {
            const m = l.replace(/[*_]/g, '').match(/^5\.\d+\.?\s*(.+)$/);
            if (m) { av = { titulo: m[1].trim(), texto: '' }; dados.avisos.push(av); continue; }
            if (ehSemAlteracao(l)) continue;
            if (!av) { av = { titulo: '', texto: '' }; dados.avisos.push(av); }
            av.texto = (av.texto ? av.texto + '\n' : '') + limparMarcador(l);
        }
    }

    // 6. Navios (subtítulos T-ORE / T-OIL)
    {
        let sub = null; const p = { tore: [], toil: [] };
        for (const l of limpo(blocos.navios)) {
            const n = normalizar(l).replace(/[^A-Z\-]/g, '');
            if (n === 'T-ORE' || n === 'TORE') { sub = 'tore'; continue; }
            if (n === 'T-OIL' || n === 'TOIL') { sub = 'toil'; continue; }
            if (sub) p[sub].push(l);
        }
        if (p.tore.length) dados.navios.tore = p.tore.join('\n');
        if (p.toil.length) dados.navios.toil = p.toil.join('\n');
    }

    // 7. Ocorrências
    dados.ocorrencias = limpo(blocos.ocorrencias).map(limparMarcador).filter(t => t && !ehSemAlteracao(t));

    // 8. Passagem de turno
    {
        let sub = null; const p = { saindo: [], assumindo: [] };
        for (const l of limpo(blocos.passagem)) {
            const n = normalizar(l);
            const m = l.replace(/[*_]/g, '').match(/^EQUIPE\s+(SAINDO|ASSUMINDO)\s*:?\s*(.*)$/i);
            if (m) {
                sub = normalizar(m[1]) === 'SAINDO' ? 'saindo' : 'assumindo';
                if (m[2].trim()) p[sub].push(m[2].trim());
                continue;
            }
            if (sub && !/^EQUIPE/.test(n)) p[sub].push(l);
        }
        if (p.saindo.length) dados.equipes.saindo = p.saindo.join(' ');
        if (p.assumindo.length) dados.equipes.assumindo = p.assumindo.join(' ');
    }

    // Conferência: o que foi e o que não foi encontrado
    const conferencia = [
        ['Data', dados.data], ['Turno', dados.turno],
        ['KM final da VTR', dados.vtr.kmFinal], ['CFTV', dados.sistemas.cftv],
        ['Controle de acesso', dados.sistemas.ca], ['OCR', dados.sistemas.ocrAssertividade],
        ['Navios T-ORE', dados.navios.tore], ['Navios T-OIL', dados.navios.toil],
        ['Equipe assumindo', dados.equipes.assumindo]
    ];
    return {
        dados,
        encontrados: conferencia.filter(([, v]) => v !== null && v !== '').map(([k]) => k),
        faltando: conferencia.filter(([, v]) => v === null || v === '').map(([k]) => k)
    };
}

// ---------------------------------------------------------------------
// Herança: monta a ficha do novo turno a partir do relatório anterior
// ---------------------------------------------------------------------
function dataDeOntem(dataBR) {
    const [d, m, a] = dataBR.split('/').map(Number);
    const dt = new Date(Date.UTC(a, m - 1, d - 1, 12));
    return agora(dt).data;
}

function fichaHerdada(relatorio, fichaAtual, config = {}) {
    const d = relatorio.dados;
    const nova = fichaVazia(config);
    const t = agora();
    const anterior = fichaAtual || {};

    nova.turno = d.turno ? (d.turno === 'DIURNO' ? 'NOTURNO' : 'DIURNO') : turnoPelaHora(t.horaNum);
    nova.data = dataDoTurno(nova.turno, t);

    const km = d.vtr.kmFinal ?? anterior.vtr?.kmFinal ?? null;
    nova.vtr = {
        modelo: d.vtr.modelo || anterior.vtr?.modelo || nova.vtr.modelo,
        placa: d.vtr.placa || anterior.vtr?.placa || nova.vtr.placa,
        kmInicial: km, kmFinal: km
    };
    nova.sistemas = {
        cftv: d.sistemas.cftv ?? anterior.sistemas?.cftv ?? '',
        ca: d.sistemas.ca ?? anterior.sistemas?.ca ?? '✓ S/A',
        ocrAssertividade: d.sistemas.ocrAssertividade ?? '',
        ocrLeituras: d.sistemas.ocrLeituras ?? ''
    };
    nova.navios = {
        tore: d.navios.tore ?? anterior.navios?.tore ?? '',
        toil: d.navios.toil ?? anterior.navios?.toil ?? ''
    };

    // Avisos continuam até alguém dar baixa: os nossos + os do relatório recebido
    const avisos = [...(anterior.avisos || [])];
    for (const av of d.avisos) {
        const chave = normalizar(av.titulo || av.texto).slice(0, 40);
        if (!avisos.some(a => normalizar(a.titulo || a.texto).slice(0, 40) === chave)) avisos.push({ id: novoId(), ...av });
    }
    nova.avisos = avisos;

    // Operações de bordo ainda abertas (sem horário final) continuam
    nova.operacoes = (anterior.operacoes || []).filter(o => !o.horaFinal);

    nova.equipes = {
        saindo: d.equipes.assumindo || '',
        assumindo: d.equipes.saindo || ''
    };
    nova.herdadoDe = { autor: relatorio.autor || '', data: d.data, turno: d.turno, capturadoEm: relatorio.capturadoEm || t.iso };
    return nova;
}

// ---------------------------------------------------------------------
// Texto oficial do relatório (um único gerador para tudo)
// ---------------------------------------------------------------------
function blocoTexto(texto, vazio = '✓ S/A') {
    const linhas = String(texto || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!linhas.length) return vazio;
    if (!/^[✓✔•\-]/.test(linhas[0])) linhas[0] = '✓ ' + linhas[0];
    return linhas.join('\n');
}

function blocoLista(itens) {
    const lista = (itens || []).map(i => limparMarcador(typeof i === 'string' ? i : i.texto)).filter(Boolean);
    return lista.length ? lista.map(t => '✓ ' + t).join('\n') : '✓ S/A';
}

function formatarKm(km) {
    const n = numeroKm(km);
    return n === null ? '—' : n.toLocaleString('pt-BR');
}

function formatarRelatorio(f, { negrito = true } = {}) {
    const b = s => (negrito ? `*${s}*` : s);
    const avisos = (f.avisos || []).filter(a => (a.titulo || a.texto || '').trim());
    const blocoAvisos = avisos.length
        ? avisos.map((a, i) => [b(`5.${i + 1}. ${(a.titulo || 'AVISO').trim()}`), (a.texto || '').trim()].filter(Boolean).join('\n')).join('\n\n')
        : '✓ S/A';
    const ocr = [
        `Assertividade: ${f.sistemas?.ocrAssertividade || '—'}`,
        `Total de leituras: ${f.sistemas?.ocrLeituras || '—'} veículos`
    ].join('\n');

    return [
        b(`RELATÓRIO DO TURNO - ${f.turno}`),
        `Data: ${f.data}`,
        '',
        b('1. EFETIVO CCOS'),
        blocoTexto(f.efetivo),
        '',
        b('2. VIATURA – VTR'),
        `Veículo: ${f.vtr?.modelo || '—'}`,
        `Placa: ${f.vtr?.placa || '—'}`,
        `KM inicial: ${formatarKm(f.vtr?.kmInicial)}`,
        `KM final: ${formatarKm(f.vtr?.kmFinal)}`,
        '',
        b('3. SISTEMAS'),
        b('CFTV'),
        blocoTexto(f.sistemas?.cftv),
        b('CA - CONTROLE DE ACESSO'),
        blocoTexto(f.sistemas?.ca),
        b('OCR - RECONHECIMENTO DE PLACAS'),
        ocr,
        '',
        b('4. ATIVIDADES REALIZADAS'),
        blocoLista(f.atividades),
        '',
        b('5. AVISOS E AÇÕES DE ACOMPANHAMENTO'),
        blocoAvisos,
        '',
        b('6. MOVIMENTAÇÃO DE NAVIOS'),
        b('T-ORE'),
        (f.navios?.tore || '').trim() || 'S/A',
        '',
        b('T-OIL'),
        (f.navios?.toil || '').trim() || 'S/A',
        '',
        b('7. OCORRÊNCIAS'),
        blocoLista(f.ocorrencias),
        '',
        b('8. PASSAGEM DE TURNO'),
        b('EQUIPE SAINDO:'),
        (f.equipes?.saindo || '').trim() || '—',
        b('EQUIPE ASSUMINDO:'),
        (f.equipes?.assumindo || '').trim() || '—'
    ].join('\n');
}

// Pendências que valem um aviso antes de publicar
function conferirFicha(f) {
    const alertas = [];
    const ki = numeroKm(f.vtr?.kmInicial), kf = numeroKm(f.vtr?.kmFinal);
    if (ki === null || kf === null) alertas.push('KM da VTR não preenchido.');
    else if (kf < ki) alertas.push('KM final menor que o KM inicial.');
    else if (kf - ki > 150) alertas.push(`VTR rodou ${kf - ki} km no turno — confira.`);
    if (!f.sistemas?.ocrAssertividade || !f.sistemas?.ocrLeituras) alertas.push('OCR (assertividade/leituras) não preenchido.');
    if (!(f.equipes?.saindo || '').trim() || !(f.equipes?.assumindo || '').trim()) alertas.push('Passagem de turno (equipes) incompleta.');
    const abertas = (f.operacoes || []).filter(o => !o.horaFinal).length;
    if (abertas) alertas.push(`${abertas} operação(ões) de bordo sem horário final.`);
    return alertas;
}

// ---------------------------------------------------------------------
// Classificação das mensagens do grupo (sugestão de destino)
// ---------------------------------------------------------------------
const RE_RUIDO = /^(bom dia|boa tarde|boa noite|ok|okay|blz|beleza|valeu|vlw|obrigad[oa]|grato|ciente|recebido|show|top|joia|tmj|positivo|copiado|qsl|sim|nao|opa|ola|bom plantao|boa folga|bom descanso|amem|kkk+|rs+|ha(ha)+)(\s+(a todos|pessoal|equipe|galera|irmao|chefe))?[\s!.,]*$/;
const RE_URGENTE = /\b(acidente|incendio|fogo|ferid[oa]s?|ambulancia|vazamento|invasao|socorrid[oa]|alagamento|sinistro|colisao|obito|afogamento|explosao|disparo|arma de fogo|emergencia)\b/;
const RE_OCORRENCIA = /\b(avaria|danificad[oa]|quebr(ou|ado|ada)|furto|roubo|arrombamento|apreensao|inconformidade|irregularidade|recusad[oa]|barrad[oa]|sem autorizacao|nao autorizad[oa])\b/;
const RE_OPERACAO = /\b(rancho|provis(ao|oes)|tripulantes?|tripulacao|residuos?|agua potavel|bunker|combustivel|dta|pecas de bordo|materiais|sobressalentes)\b/;
const RE_NAVIO = /\b(atracad[oa]|desatracad[oa]|atracacao|desatracacao|fundead[oa]|pratico|eta|etb|etd|amarrad[oa])\b/;
const RE_AVISO = /\b(acompanhar|atentar|programad[oa] para|aguardando|pendente|previsto para|prevista para|amanha)\b/;
const RE_SAIDA = /\b(saida|saiu|deixou o terminal|liberad[oa] na saida)\b/;
const RE_PLACA = /\b([A-Z]{3})[- ]?([0-9][A-Z0-9][0-9]{2})\b/i;

function extrairCampos(texto) {
    const t = String(texto || '');
    const placa = t.match(RE_PLACA);
    const navio = t.match(/\b(?:MV|M\/V|NAVIO)\s*[-–:]?\s*([A-Z0-9][A-Z0-9 .]{2,30}?)(?=\s*[–\-:.,;(]|\s+T-|\s*$)/i);
    const term = normalizar(t).match(/\bT-?(ORE|OIL)\b/);
    const hora = t.match(/\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)\b/);
    const qtd = t.match(/\b(\d{1,3})\s*tripulantes?\b/i);
    const n = normalizar(t);
    return {
        placa: placa ? `${placa[1]}-${placa[2]}`.toUpperCase() : '',
        navio: navio ? navio[1].trim().toUpperCase() : '',
        terminal: term ? (term[1] === 'ORE' ? 'T-ORE' : 'T-OIL') : '',
        hora: hora ? `${hora[1].padStart(2, '0')}:${hora[2]}` : '',
        quantidade: qtd ? qtd[1].padStart(2, '0') : '',
        movimento: /DESEMBARQUE/.test(n) && /\bEMBARQUE\b/.test(n.replace(/DESEMBARQUE/g, '')) ? 'Embarque e desembarque'
            : /DESEMBARQUE/.test(n) ? 'Desembarque' : /EMBARQUE/.test(n) ? 'Embarque' : ''
    };
}

function tipoOperacaoDoTexto(texto) {
    const n = semAcento(String(texto || '')).toLowerCase();
    if (/tripula/.test(n)) return 'MOVIMENTAÇÃO DE TRIPULAÇÃO';
    if (/rancho|provis/.test(n)) return 'FORNECIMENTO DE RANCHO';
    if (/residuo/.test(n)) return 'RETIRADA DE RESÍDUOS';
    if (/agua potavel|agua/.test(n)) return 'FORNECIMENTO DE ÁGUA POTÁVEL';
    if (/bunker|combustivel/.test(n)) return 'ABASTECIMENTO DE COMBUSTÍVEL';
    if (/dta|materia|pecas|sobressalente|equipamento/.test(n)) return 'FORNECIMENTO DE MATERIAIS E EQUIPAMENTOS';
    return 'OUTRA OPERAÇÃO';
}

function classificarMensagem(texto) {
    const n = semAcento(String(texto || '')).toLowerCase().trim();
    const campos = extrairCampos(texto);
    const base = { ruido: false, urgente: false, sugestao: 'ATIVIDADE', campos };
    if (n.length < 4 || RE_RUIDO.test(n) || !/[a-z0-9]/.test(n)) return { ...base, ruido: true, sugestao: 'IGNORAR' };
    if (RE_URGENTE.test(n)) return { ...base, urgente: true, sugestao: 'OCORRENCIA' };
    if (RE_SAIDA.test(n) && campos.placa) return { ...base, sugestao: 'SAIDA' };
    if (RE_OCORRENCIA.test(n)) return { ...base, sugestao: 'OCORRENCIA' };
    if (RE_OPERACAO.test(n)) return { ...base, sugestao: 'OPERACAO' };
    if (RE_NAVIO.test(n)) return { ...base, sugestao: 'NAVIO' };
    if (RE_AVISO.test(n)) return { ...base, sugestao: 'AVISO' };
    return base;
}

// ---------------------------------------------------------------------
// Minutas de e-mail das operações de bordo
// ---------------------------------------------------------------------
function saudacao(horaNum) {
    if (horaNum >= 5 && horaNum < 12) return 'Prezados, bom dia!';
    if (horaNum >= 12 && horaNum < 18) return 'Prezados, boa tarde!';
    return 'Prezados, boa noite!';
}

function hh(h) { return h ? (String(h).endsWith('h') ? h : `${h}h`) : 'Em andamento'; }

function minutaEmail(op, ficha, config = {}) {
    const t = agora();
    const data = op.data || ficha?.data || t.data;
    const sa = v => (v && String(v).trim()) || 'S/A';
    const veiculo = [op.veiculo, op.placa ? `Placa ${op.placa}` : ''].filter(Boolean).join(' - ') || 'S/A';
    const tipo = op.tipo || 'OUTRA OPERAÇÃO';
    const assunto = `${tipo} - ${(op.navio || 'NAVIO').toUpperCase()} - ${(op.terminal || '').toUpperCase()} - ${data.replace(/\//g, '-')}`;
    const L = linhas => linhas.map(l => `\t✓ ${l}`).join('\n');
    const horarios = `Horário inicial: ${hh(op.horaInicial)}          Horário final: ${hh(op.horaFinal)}`;
    let corpo;

    if (tipo === 'MOVIMENTAÇÃO DE TRIPULAÇÃO') {
        corpo = `Registro a movimentação de tripulação:\n\n` + L([
            `Data: ${data}`, `Navio: ${sa(op.navio)}`, `Terminal: ${sa(op.terminal)}`,
            `Quantos: ${sa(op.quantidade)}`, `Embarque ou desembarque: ${sa(op.movimento)}`, horarios,
            `Empresa responsável/ Agência: ${sa(op.empresa)}`,
            `Agente/ Motorista autorizado responsável: ${sa(op.responsavel)}`,
            `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${sa(op.autoridades)}`, `Autorizados por (Terminal): ${sa(op.autorizadoTerminal)}`,
            `Observações: ${sa(op.observacoes)}`, `Status: ${op.status || 'Sem alteração'}`,
            `Procedimentos de segurança realizados: ${PROCEDIMENTOS_PADRAO}`, `Evidências: Em anexo`
        ]);
    } else if (/^FORNECIMENTO DE (RANCHO|MATERIAIS)/.test(tipo)) {
        corpo = `Registro o fornecimento de bordo:\n\n` + L([
            `Tipo: ${tipo.replace('FORNECIMENTO DE ', '').toLowerCase().replace(/^./, c => c.toUpperCase())}`,
            `Data: ${data}`, horarios, `Terminal: ${sa(op.terminal)}`, `Navio: ${sa(op.navio)}`,
            `Empresa responsável/ Fornecedor: ${sa(op.empresa)}`, `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${sa(op.autoridades)}`, `Autorizados por (Terminal): ${sa(op.autorizadoTerminal)}`,
            `Observações: ${sa(op.observacoes)}`,
            `Procedimentos de segurança realizados: ${PROCEDIMENTOS_FORNECIMENTO}`,
            `Status: ${op.status || 'Sem alteração'}`, `Evidências: Em anexo`
        ]);
    } else {
        corpo = `Registro a operação de ${tipo.toLowerCase()}:\n\n` + L([
            `Tipo: ${tipo}`, `Data: ${data}`, horarios, `Terminal: ${sa(op.terminal)}`, `Navio: ${sa(op.navio)}`,
            `Empresa responsável/ Prestador: ${sa(op.empresa)}`, `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${sa(op.autoridades)}`, `Autorizados por (Terminal): ${sa(op.autorizadoTerminal)}`,
            `Observações: ${sa(op.observacoes)}`,
            `Procedimentos de segurança realizados: ${PROCEDIMENTOS_PADRAO}`,
            `Status: ${op.status || 'Sem alteração'}`, `Evidências: Em anexo`
        ]);
    }

    corpo = `${saudacao(t.horaNum)}\n\n${corpo}\n\nInformo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
    return { para: config.emailDestinatarios || '', cc: config.emailCopia || '', assunto, corpo };
}

// Frase para a seção 4 a partir de uma operação de bordo
function atividadeDaOperacao(op) {
    const navio = op.navio ? `${op.navio}${op.terminal ? ' – ' + op.terminal : ''}. ` : '';
    let desc;
    if (op.tipo === 'MOVIMENTAÇÃO DE TRIPULAÇÃO') desc = `${op.movimento || 'Movimentação'} de ${op.quantidade || ''} tripulante(s)`.replace(/\s+/g, ' ');
    else desc = (op.tipo || 'Operação').toLowerCase().replace(/^./, c => c.toUpperCase());
    const empresa = op.empresa ? ` (${op.empresa})` : '';
    const hor = op.horaInicial ? ` Início às ${op.horaInicial}${op.horaFinal ? `, término às ${op.horaFinal}` : ''}.` : '';
    return `${navio}${desc}${empresa}.${hor}`.replace(/\.\./g, '.');
}

module.exports = {
    fichaVazia, ehRelatorioDeTurno, lerRelatorio, fichaHerdada,
    formatarRelatorio, conferirFicha, classificarMensagem, extrairCampos,
    tipoOperacaoDoTexto, minutaEmail, atividadeDaOperacao, numeroKm
};

// =====================================================================
// REGRAS DO RELATÓRIO (fonte única)
//  - leitura do relatório do turno postado no grupo
//  - herança para o novo turno
//  - texto oficial do relatório (8 seções) e da Passagem da Escala
//  - leitura das mensagens do grupo (inclusive o formato *Campo:* valor)
//  - operações de bordo e modelos de e-mail
// Padrões de texto seguem o robô antigo do CCOS.
// =====================================================================
const {
    agora, turnoPelaHora, dataDoTurno, diaSeguinte, novoId, semAcento, limparMarcador,
    normalizarHora, normalizarPlaca, normalizarTerminal, normalizarTexto
} = require('./util');

// ---------------------------------------------------------------------
// Tipos de operação de bordo
// ---------------------------------------------------------------------
const PROC_TRIPULACAO = '(Identificação, verificação das autorizações, Briefing de segurança, inspeções, acompanhamento e monitoramento).';
const PROC_FORNECIMENTO = '(Identificação, verificação das autorizações, Check List, Briefing de segurança, conferência das Notas Fiscais, inspeções, acompanhamento e monitoramento).';

const TIPOS_OPERACAO = {
    TRIPULACAO: { rotulo: 'Movimentação de tripulantes', assunto: 'MOVIMENTAÇÃO DE TRIPULAÇÃO', tipo: 'Movimentação de tripulação', autoridade: 'Polícia Federal' },
    RANCHO: { rotulo: 'Fornecimento de rancho', assunto: 'FORNECIMENTO DE RANCHO', tipo: 'Rancho', resumo: 'Fornecimento de Rancho.' },
    MATERIAIS: { rotulo: 'Materiais e equipamentos', assunto: 'FORNECIMENTO DE MATERIAIS E EQUIPAMENTOS', tipo: 'Materiais e equipamentos', resumo: 'Fornecimento de Materiais.' },
    DTA: { rotulo: 'DTA', assunto: 'FORNECIMENTO DE DTA', tipo: 'DTA', resumo: 'Fornecimento de DTA.' },
    AGUA: { rotulo: 'Água potável', assunto: 'FORNECIMENTO DE ÁGUA POTÁVEL', tipo: 'Água potável', resumo: 'Fornecimento de Água Potável.' },
    COMBUSTIVEL: { rotulo: 'Combustível', assunto: 'ABASTECIMENTO DE COMBUSTÍVEL', tipo: 'Combustível', resumo: 'Abastecimento de Combustível.' },
    RESIDUOS: { rotulo: 'Retirada de resíduos', assunto: 'RETIRADA DE RESÍDUOS', tipo: 'Retirada de resíduos', resumo: 'Retirada de Resíduos.' },
    K9: { rotulo: 'Inspeção K9', assunto: 'INSPEÇÃO K9', tipo: 'Inspeção K9', resumo: 'Inspeção K9.' },
    MERGULHO: { rotulo: 'Mergulho', assunto: 'INSPEÇÃO SUBMARINA - MERGULHO', tipo: 'Inspeção submarina (mergulho)', resumo: 'Inspeção submarina (mergulho).' },
    LACRE: { rotulo: 'Lacre / deslacração', assunto: 'LACRE - DESLACRAÇÃO', tipo: 'Lacre / deslacração', resumo: 'Lacre / deslacração.' },
    OUTRA: { rotulo: 'Outra operação', assunto: 'OPERAÇÃO DE BORDO', tipo: 'Operação de bordo', resumo: 'Operação de bordo.' }
};
for (const t of Object.values(TIPOS_OPERACAO)) if (!t.autoridade) t.autoridade = 'Receita Federal';

const MOVIMENTOS = ['Embarque', 'Desembarque', 'Embarque e Desembarque', 'Saída a passeio', 'Saída para atendimento médico'];

const NAVIOS_PADRAO = [
    ['MV - LILA PSARA', 'T-ORE'], ['MARAN COURAGE', 'T-ORE'], ['MARLENE OLDENDORFF', 'T-ORE'],
    ['BARCELONA SPIRIT', 'T-OIL'], ['NISSOS NIKOURIA', 'T-OIL'], ['AROSA', 'T-OIL'], ['YUAN DONG HAI', 'T-OIL'],
    ['EAGLE PAULINIA', 'T-OIL'], ['PERTAMINA PRIME', 'T-OIL'], ['ALMI ODYSSEY', 'T-OIL'],
    ['SYNNOEVE KNUTSEN', 'T-OIL'], ['SEAWAYS CAPE HENRY', 'T-OIL'], ['MARAN GAS', 'T-OIL']
].map(([nome, terminal]) => ({ nome, terminal }));

function tipoOperacaoDoTexto(texto) {
    const n = semAcento(texto).toLowerCase();
    if (/tripula|embarque|desembarque|passeio|atendimento medico/.test(n)) return 'TRIPULACAO';
    if (/rancho|provis|viveres|alimento/.test(n)) return 'RANCHO';
    if (/residuo|lixo|borra/.test(n)) return 'RESIDUOS';
    if (/agua potavel|\bagua\b/.test(n)) return 'AGUA';
    if (/bunker|combustivel|diesel/.test(n)) return 'COMBUSTIVEL';
    if (/\bk-?9\b|canin/.test(n)) return 'K9';
    if (/mergulh|submarin/.test(n)) return 'MERGULHO';
    if (/lacre|deslacra/.test(n)) return 'LACRE';
    if (/\bdta\b/.test(n)) return 'DTA';
    if (/materia|pecas|sobressalente|equipamento/.test(n)) return 'MATERIAIS';
    return 'OUTRA';
}

function movimentoDoTexto(texto) {
    const n = semAcento(texto).toUpperCase();
    if (/ATENDIMENTO MEDICO|MEDICO|HOSPITAL/.test(n)) return 'Saída para atendimento médico';
    if (/PASSEIO|SHORE LEAVE/.test(n)) return 'Saída a passeio';
    const des = /DESEMBARQUE/.test(n);
    const emb = /\bEMBARQUE/.test(n.replace(/DESEMBARQUE/g, ''));
    if (des && emb) return 'Embarque e Desembarque';
    if (des) return 'Desembarque';
    if (emb) return 'Embarque';
    return '';
}

function formatarQtdTripulantes(q) {
    const n = parseInt(String(q || '').replace(/\D/g, ''), 10);
    if (!n) return '01 tripulante';
    return `${String(n).padStart(2, '0')} tripulante${n === 1 ? '' : 's'}`;
}

// Linha da seção 6 para uma operação (padrão do robô antigo)
function resumoNavio(op) {
    if (op.tipo === 'TRIPULACAO') return `${op.movimento || 'Embarque'} de ${formatarQtdTripulantes(op.quantidade)}.`;
    return (TIPOS_OPERACAO[op.tipo] || TIPOS_OPERACAO.OUTRA).resumo;
}

// ---------------------------------------------------------------------
// Ficha do turno
// ---------------------------------------------------------------------
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
        navios: { tore: [], toil: [] },
        ocorrencias: [],
        equipes: { saindo: '', assumindo: '' },
        herdadoDe: null,
        publicadoEm: null,
        criadoEm: t.iso,
        atualizadoEm: t.iso
    };
}

// Converte texto da seção 6 em lista { navio, linhas[] }.
// Aceita "*NAVIO*\n✓ linha" (robô antigo) e "NAVIO: situação" (relatório da US).
function naviosDeTexto(texto) {
    const lista = [];
    let atual = null;
    for (const bruta of String(texto || '').split('\n')) {
        const linha = bruta.trim();
        if (!linha || ehSemAlteracao(linha)) continue;
        const semMarc = limparMarcador(linha);
        const titulo = linha.match(/^\*([^*]+)\*$/);
        if (titulo) { atual = { id: novoId(), navio: titulo[1].trim().toUpperCase(), linhas: [] }; lista.push(atual); continue; }
        const comDoisPontos = semMarc.match(/^([A-Z0-9][A-Z0-9 .\-]{2,40}?)\s*:\s*(.+)$/);
        if (!/^[✓✔•]/.test(linha) && comDoisPontos && comDoisPontos[1] === comDoisPontos[1].toUpperCase()) {
            const nome = comDoisPontos[1].trim();
            let n = lista.find(x => x.navio === nome);
            if (!n) { n = { id: novoId(), navio: nome, linhas: [] }; lista.push(n); }
            n.linhas.push(comDoisPontos[2].trim());
            atual = n; continue;
        }
        if (!atual) { atual = { id: novoId(), navio: '', linhas: [] }; lista.push(atual); }
        atual.linhas.push(semMarc);
    }
    return lista;
}

function adicionarLinhaNavio(ficha, terminal, nomeNavio, linha) {
    const chave = terminal === 'T-OIL' ? 'toil' : 'tore';
    ficha.navios = ficha.navios || { tore: [], toil: [] };
    ficha.navios[chave] = ficha.navios[chave] || [];
    const alvo = semAcento(nomeNavio).toUpperCase().replace(/^MV\s*-?\s*/, '').trim();
    let n = ficha.navios[chave].find(x => semAcento(x.navio).toUpperCase().replace(/^MV\s*-?\s*/, '').trim() === alvo);
    if (!n) { n = { id: novoId(), navio: nomeNavio.toUpperCase(), linhas: [] }; ficha.navios[chave].push(n); }
    if (!n.linhas.includes(linha)) n.linhas.push(linha);
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
    const t = limparMarcador(texto);
    return /^S\s*\/?\s*A\.?$/i.test(t) || /^SEM ALTERAC/i.test(normalizar(t));
}

function lerRelatorio(textoOriginal) {
    const texto = normalizarTexto(textoOriginal);
    const linhas = texto.split('\n');
    const dados = {
        data: null, turno: null, efetivo: null,
        vtr: { modelo: null, placa: null, kmInicial: null, kmFinal: null },
        sistemas: { cftv: null, ca: null, ocrAssertividade: null, ocrLeituras: null },
        atividades: [], avisos: [],
        navios: { tore: [], toil: [] },
        ocorrencias: [],
        equipes: { saindo: null, assumindo: null }
    };

    for (const l of linhas.slice(0, 5)) {
        const mt = normalizar(l).match(/TURNO\s*[-:]?\s*(DIURNO|NOTURNO)/);
        if (mt) dados.turno = mt[1];
        const md = l.match(/Data:?\s*(\d{2}\/\d{2}\/\d{4})/i);
        if (md) dados.data = md[1];
    }

    const blocos = {};
    let atual = null;
    for (const l of linhas) {
        const s = secaoDaLinha(l);
        if (s) { atual = s; blocos[s] = blocos[s] || []; continue; }
        if (atual) blocos[atual].push(l);
    }
    const limpo = arr => (arr || []).map(l => l.trim()).filter(Boolean);

    if (blocos.efetivo) dados.efetivo = limpo(blocos.efetivo).join('\n') || null;

    for (const l of limpo(blocos.vtr)) {
        const n = normalizar(l);
        let m;
        if ((m = l.match(/Ve[íi]culo:?\s*(.+)/i))) dados.vtr.modelo = m[1].trim();
        else if ((m = l.match(/Placa:?\s*(.+)/i))) dados.vtr.placa = m[1].trim();
        else if (/KM\s*INICIAL/.test(n)) dados.vtr.kmInicial = numeroKm(l.split(':').slice(1).join(':'));
        else if (/KM\s*FINAL/.test(n)) dados.vtr.kmFinal = numeroKm(l.split(':').slice(1).join(':'));
    }

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

    dados.atividades = limpo(blocos.atividades).map(limparMarcador).filter(t => t && !ehSemAlteracao(t));

    {
        let av = null;
        for (const l of limpo(blocos.avisos)) {
            const m = l.replace(/[*_]/g, '').match(/^5\.\d+\.?\s*(.+)$/);
            if (m) { av = { titulo: m[1].trim(), texto: '' }; dados.avisos.push(av); continue; }
            if (ehSemAlteracao(l)) continue;
            if (!av) { av = { titulo: '', texto: '' }; dados.avisos.push(av); }
            av.texto = (av.texto ? av.texto + '\n' : '') + limparMarcador(l);
        }
        // "5.1. AVISO" (robô antigo): usa a 1ª linha do texto como título
        for (const a of dados.avisos) {
            if (/^AVISO$/i.test(a.titulo) || !a.titulo) {
                const [primeira, ...resto] = (a.texto || '').split('\n');
                a.titulo = primeira.split(':')[0].slice(0, 70).toUpperCase();
                a.texto = resto.length ? resto.join('\n') : primeira;
            }
        }
    }

    {
        let sub = null; const p = { tore: [], toil: [] };
        for (const l of limpo(blocos.navios)) {
            const n = normalizar(l).replace(/[^A-Z\-]/g, '');
            if (n === 'T-ORE' || n === 'TORE') { sub = 'tore'; continue; }
            if (n === 'T-OIL' || n === 'TOIL') { sub = 'toil'; continue; }
            if (sub) p[sub].push(l);
        }
        dados.navios.tore = naviosDeTexto(p.tore.join('\n'));
        dados.navios.toil = naviosDeTexto(p.toil.join('\n'));
    }

    dados.ocorrencias = limpo(blocos.ocorrencias).map(limparMarcador).filter(t => t && !ehSemAlteracao(t));

    {
        let sub = null; const p = { saindo: [], assumindo: [] };
        for (const l of limpo(blocos.passagem)) {
            const n = normalizar(l);
            const m = l.replace(/[*_]/g, '').match(/^EQUIPE\s+(SAINDO|ASSUMINDO)\s*:?\s*(.*)$/i);
            if (m) {
                sub = normalizar(m[1]) === 'SAINDO' ? 'saindo' : 'assumindo';
                if (m[2].trim()) p[sub].push(limparMarcador(m[2]));
                continue;
            }
            if (sub && !/^EQUIPE/.test(n)) p[sub].push(limparMarcador(l));
        }
        if (p.saindo.length) dados.equipes.saindo = p.saindo.join(' ');
        if (p.assumindo.length) dados.equipes.assumindo = p.assumindo.join(' ');
    }

    const conferencia = [
        ['Data', dados.data], ['Turno', dados.turno],
        ['KM final da VTR', dados.vtr.kmFinal], ['CFTV', dados.sistemas.cftv],
        ['Controle de acesso', dados.sistemas.ca], ['OCR', dados.sistemas.ocrAssertividade],
        ['Navios', dados.navios.tore.length + dados.navios.toil.length || null],
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
function fichaHerdada(relatorio, fichaAtual, config = {}) {
    const d = relatorio.dados;
    const nova = fichaVazia(config);
    const t = agora();
    const anterior = fichaAtual || {};

    nova.turno = d.turno ? (d.turno === 'DIURNO' ? 'NOTURNO' : 'DIURNO') : turnoPelaHora(t.horaNum);
    // DIURNO de D → NOTURNO de D ; NOTURNO de D → DIURNO de D+1 (sem depender do relógio)
    nova.data = d.data && d.turno ? (d.turno === 'DIURNO' ? d.data : diaSeguinte(d.data)) : dataDoTurno(nova.turno, t);

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
    const temNavios = d.navios.tore.length || d.navios.toil.length;
    nova.navios = temNavios
        ? { tore: d.navios.tore, toil: d.navios.toil }
        : JSON.parse(JSON.stringify(anterior.navios || { tore: [], toil: [] }));

    nova.equipes = { saindo: d.equipes.assumindo || '', assumindo: d.equipes.saindo || '' };
    nova.herdadoDe = {
        relatorioId: relatorio.id || null, autor: relatorio.autor || '', data: d.data, turno: d.turno,
        capturadoEm: relatorio.capturadoEm || t.iso, encontrados: relatorio.encontrados, faltando: relatorio.faltando
    };
    return nova;
}

// ---------------------------------------------------------------------
// Texto oficial do relatório
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

function blocoNavios(lista, b) {
    const itens = (lista || []).filter(n => (n.navio || '').trim() || (n.linhas || []).some(Boolean));
    if (!itens.length) return '✓ S/A';
    return itens.map(n => {
        const linhas = (n.linhas || []).map(limparMarcador).filter(Boolean).map(l => '✓ ' + l);
        return [n.navio ? b(n.navio.trim()) : null, ...linhas].filter(Boolean).join('\n');
    }).join('\n\n');
}

// avisos: pendências do tipo AVISO em aberto [{titulo, texto, historico}]
function textoAviso(p) {
    const ultima = (p.historico || []).filter(h => h.tipo === 'ATUALIZACAO').slice(-1)[0];
    const base = (p.texto || '').trim();
    return ultima ? `${base}${base ? '\n' : ''}Atualização (${ultima.data} ${ultima.hora}h): ${ultima.texto}` : base;
}

function formatarRelatorio(f, avisos = [], { negrito = true } = {}) {
    const b = s => (negrito ? `*${s}*` : s);
    const abertos = (avisos || []).filter(a => (a.titulo || a.texto || '').trim());
    const blocoAvisos = abertos.length
        ? abertos.map((a, i) => [b(`5.${i + 1}. ${(a.titulo || 'AVISO').trim()}`), textoAviso(a)].filter(Boolean).join('\n')).join('\n\n')
        : '✓ S/A';

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
        '',
        b('CA - CONTROLE DE ACESSO'),
        blocoTexto(f.sistemas?.ca),
        '',
        b('OCR – RECONHECIMENTO DE PLACAS'),
        `Assertividade: ${f.sistemas?.ocrAssertividade || '—'};`,
        `Total de leituras: ${f.sistemas?.ocrLeituras || '—'} veículos.`,
        '',
        b('4. ATIVIDADES REALIZADAS'),
        blocoLista(f.atividades),
        '',
        b('5. AVISOS E AÇÕES DE ACOMPANHAMENTO'),
        blocoAvisos,
        '',
        b('6. MOVIMENTAÇÃO DE NAVIOS'),
        b('T-ORE'),
        blocoNavios(f.navios?.tore, b),
        '',
        b('T-OIL'),
        blocoNavios(f.navios?.toil, b),
        '',
        b('7. OCORRÊNCIAS'),
        blocoLista(f.ocorrencias),
        '',
        b('8. PASSAGEM DE TURNO'),
        b('EQUIPE SAINDO:'),
        (f.equipes?.saindo || '').trim() || 'Conforme escala',
        '',
        b('EQUIPE ASSUMINDO:'),
        (f.equipes?.assumindo || '').trim() || 'Conforme escala'
    ].join('\n');
}

function conferirFicha(f, operacoes = []) {
    const alertas = [];
    const ki = numeroKm(f.vtr?.kmInicial), kf = numeroKm(f.vtr?.kmFinal);
    if (ki === null || kf === null) alertas.push('KM da VTR não preenchido.');
    else if (kf < ki) alertas.push('KM final menor que o KM inicial.');
    else if (kf - ki > 150) alertas.push(`VTR rodou ${kf - ki} km no turno — confira.`);
    if (!f.sistemas?.ocrAssertividade || !f.sistemas?.ocrLeituras) alertas.push('OCR (assertividade/leituras) não preenchido.');
    if (!(f.equipes?.saindo || '').trim() || !(f.equipes?.assumindo || '').trim()) alertas.push('Passagem de turno (equipes) incompleta.');
    const abertas = (operacoes || []).filter(o => !o.horaFinal).length;
    if (abertas) alertas.push(`${abertas} operação(ões) de bordo sem horário de saída.`);
    return alertas;
}

// ---------------------------------------------------------------------
// Passagem da Escala (relatório consolidado da escala)
// ---------------------------------------------------------------------
function formatarPassagemEscala(periodo, secoes, { negrito = true } = {}) {
    const b = s => (negrito ? `*${s}*` : s);
    const lista = itens => blocoLista((itens || []).map(i => i.texto));
    return [
        b('PASSAGEM DE TURNO'),
        `Período: ${periodo}`,
        '',
        b('1. PENDÊNCIAS DA DIGITAL (CFTV E INFRAESTRUTURA)'),
        lista(secoes.digital),
        '',
        b('2. AVISOS E AÇÕES DE ACOMPANHAMENTO'),
        lista(secoes.avisos),
        '',
        b('3. RESUMO DAS OCORRÊNCIAS'),
        lista(secoes.ocorrencias),
        '',
        b('4. RESUMO DAS ATIVIDADES REALIZADAS'),
        lista(secoes.atividades)
    ].join('\n');
}

// ---------------------------------------------------------------------
// Mensagens do grupo: formato padrão "*Campo:* valor"
// ---------------------------------------------------------------------
const ROTULOS = [
    [/^tipo( de operacao| de fornecimento)?$/, 'tipo'],
    [/^terminal$/, 'terminal'],
    [/^(navio|navios|embarcacao|mv)$/, 'navio'],
    [/^(empresa|empresa responsavel|agencia|fornecedor|prestador)$/, 'empresa'],
    [/^(motorista|agente|motorista autorizado|responsavel)$/, 'responsavel'],
    [/^(ajudante|ajudantes|auxiliar)$/, 'ajudante'],
    [/^(veiculo|carro|caminhao)$/, 'veiculo'],
    [/^placa$/, 'placa'],
    [/^(entrada|entrada na portaria|horario inicial|inicio|chegada|hora de entrada)$/, 'horaInicial'],
    [/^(saida|saida na portaria|horario final|termino|hora de saida)$/, 'horaFinal'],
    [/^(quantidade|quantos|qtd|qtde|tripulantes|n de tripulantes)$/, 'quantidade'],
    [/^(movimento|embarque ou desembarque|movimentacao)$/, 'movimento'],
    [/^(observacao|observacoes|obs)$/, 'observacoes']
];

function lerMensagemPadrao(textoOriginal) {
    const texto = normalizarTexto(textoOriginal);
    const campos = {};
    const navios = [];
    let titulo = '';
    let reconhecidos = 0;
    for (const bruta of texto.split('\n')) {
        const linha = bruta.replace(/[*_~]/g, '').trim();
        if (!linha) continue;
        const m = linha.match(/^([A-Za-zÀ-ÿº°\/ .()]{2,40}?)\s*:\s*(.*)$/);
        if (!m) { if (!titulo && !reconhecidos) titulo = linha; continue; }
        const rot = semAcento(m[1]).toLowerCase().replace(/[().º°]/g, '').replace(/\s+/g, ' ').trim();
        const valor = m[2].trim();
        const achado = ROTULOS.find(([re]) => re.test(rot));
        if (!achado) continue;
        reconhecidos++;
        const chave = achado[1];
        if (chave === 'navio') {
            valor.split(/\s*(?:,|\/|;|\s+e\s+)\s*/i).map(v => v.trim().toUpperCase()).filter(Boolean).forEach(v => navios.push(v));
        } else if (!campos[chave]) campos[chave] = valor;
    }
    return { estruturada: reconhecidos >= 3, titulo, campos, navios };
}

// ---------------------------------------------------------------------
// Classificação das mensagens (sugestão de destino)
// ---------------------------------------------------------------------
const RE_RUIDO = /^(bom dia|boa tarde|boa noite|ok|okay|blz|beleza|valeu|vlw|obrigad[oa]|grato|ciente|recebido|show|top|joia|tmj|positivo|copiado|qsl|sim|nao|opa|ola|oi|bom plantao|boa folga|bom descanso|amem|kkk+|rs+|ha(ha)+)(\s+(a todos|pessoal|equipe|galera|irmao|chefe))?[\s!.,]*$/;
const RE_URGENTE = /\b(acidente|incendio|fogo|ferid[oa]s?|ambulancia|vazamento|invasao|socorrid[oa]|alagamento|sinistro|colisao|obito|afogamento|explosao|disparo|arma de fogo|emergencia)\b/;
const RE_OCORRENCIA = /\b(avaria|danificad[oa]|quebr(ou|ado|ada)|furto|roubo|arrombamento|apreensao|inconformidade|irregularidade|recusad[oa]|barrad[oa]|sem autorizacao|nao autorizad[oa]|arriada)\b/;
const RE_OPERACAO = /\b(rancho|provis(ao|oes)|tripulantes?|tripulacao|residuos?|agua potavel|bunker|combustivel|dta|pecas de bordo|sobressalentes|k9|mergulho|lacre|deslacracao)\b/;
const RE_DIGITAL = /\b(digital|spda|dps|cftv|cameras?|fibra|nobreak|postes?|filtragem)\b/;
const RE_NAVIO = /\b(atracad[oa]|desatracad[oa]|atracacao|desatracacao|fundead[oa]|pratico|eta|etb|etd|amarrad[oa])\b/;
const RE_AVISO = /\b(acompanhar|atentar|programad[oa] para|aguardando|pendente|previsto para|prevista para|amanha|verificar)\b/;
const RE_SAIDA = /\b(saida|saiu|deixou o terminal|liberad[oa] na saida)\b/;

function navioConhecido(texto, navios = NAVIOS_PADRAO) {
    const n = semAcento(texto).toUpperCase();
    for (const nav of navios) {
        const nome = semAcento(nav.nome).toUpperCase().replace(/^MV\s*-?\s*/, '').trim();
        if (nome && new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`).test(n)) return nav;
    }
    return null;
}

function terminalDoNavio(nome, navios = NAVIOS_PADRAO) {
    return navioConhecido(nome, navios)?.terminal || '';
}

function extrairCampos(textoOriginal, navios = NAVIOS_PADRAO) {
    const t = normalizarTexto(textoOriginal);
    const navio = t.match(/\b(?:MV|M\/V|NAVIO)\s*[-:]?\s*([A-Z0-9][A-Z0-9 .]{2,30}?)(?=\s*[-:.,;(]|\s+T-|\s*$)/i);
    const qtd = t.match(/\b(\d{1,3})\s*tripulantes?\b/i);
    const conhecido = navioConhecido(t, navios);
    return {
        placa: normalizarPlaca(t),
        navio: navio ? navio[1].trim().toUpperCase() : (conhecido ? conhecido.nome : ''),
        terminal: normalizarTerminal(t) || conhecido?.terminal || '',
        hora: normalizarHora(t),
        quantidade: qtd ? qtd[1].padStart(2, '0') : '',
        movimento: movimentoDoTexto(t)
    };
}

// Rascunhos de operação (um por navio) a partir de uma mensagem
function rascunhosOperacao(textoOriginal, horaMensagem, navios = NAVIOS_PADRAO) {
    const texto = normalizarTexto(textoOriginal);
    const p = lerMensagemPadrao(texto);
    const c = p.campos;
    const livre = extrairCampos(texto, navios);
    const tipo = tipoOperacaoDoTexto(`${c.tipo || ''} ${p.titulo} ${texto}`);
    const listaNavios = p.navios.length ? p.navios : (livre.navio ? [livre.navio] : ['']);
    const terminalGeral = normalizarTerminal(c.terminal || '') || livre.terminal;
    const qtd = c.quantidade || livre.quantidade;
    return listaNavios.map(nomeNavio => {
        const conhecido = nomeNavio ? navioConhecido(nomeNavio, navios) : null;
        return {
            tipo,
            navio: (conhecido && semAcento(conhecido.nome).replace(/^MV\s*-?\s*/i, '') === semAcento(nomeNavio).replace(/^MV\s*-?\s*/i, '') ? conhecido.nome : nomeNavio).toUpperCase(),
            terminal: terminalGeral || conhecido?.terminal || '',
            empresa: (c.empresa || '').toUpperCase(),
            responsavel: (c.responsavel || '').toUpperCase(),
            ajudante: (c.ajudante || '').toUpperCase(),
            veiculo: (c.veiculo || '').toUpperCase(),
            placa: normalizarPlaca(c.placa || '') || livre.placa,
            quantidade: tipo === 'TRIPULACAO' ? (qtd ? String(parseInt(qtd, 10) || '').padStart(2, '0') : '') : '',
            movimento: tipo === 'TRIPULACAO' ? (c.movimento ? movimentoDoTexto(c.movimento) || c.movimento : movimentoDoTexto(texto) || 'Embarque') : '',
            horaInicial: normalizarHora(c.horaInicial || '') || (c.horaFinal ? '' : (livre.hora || horaMensagem || '')),
            horaFinal: normalizarHora(c.horaFinal || ''),
            observacoes: c.observacoes || ''
        };
    });
}

// Frase da seção 4 para as operações de uma mensagem (padrão "✓ 19:01h ...")
function atividadeDasOperacoes(ops, horaMensagem) {
    if (!ops.length) return '';
    const o = ops[0];
    const navios = ops.map(x => x.navio).filter(Boolean);
    const nomesNavios = navios.length > 1 ? `${navios.slice(0, -1).join(', ')} e ${navios.slice(-1)}` : (navios[0] || '');
    const descricao = o.tipo === 'TRIPULACAO'
        ? `${o.movimento || 'Movimentação'} de ${formatarQtdTripulantes(o.quantidade)}`
        : (TIPOS_OPERACAO[o.tipo] || TIPOS_OPERACAO.OUTRA).resumo.replace(/\.$/, '');
    const detalhes = [
        o.empresa ? `empresa ${o.empresa}` : '', o.responsavel ? `motorista ${o.responsavel}` : '',
        o.ajudante ? `ajudante ${o.ajudante}` : '',
        (o.veiculo || o.placa) ? `${(o.veiculo || 'veículo').toLowerCase()}${o.placa ? ' placa ' + o.placa : ''}` : ''
    ].filter(Boolean).join(', ');
    const hora = o.horaInicial || o.horaFinal || horaMensagem || '';
    let frase = `${hora ? hora + 'h ' : ''}${descricao}${nomesNavios ? ' – ' + nomesNavios : ''}${o.terminal ? ' – ' + o.terminal : ''}.`;
    if (detalhes) frase += ` ${detalhes.charAt(0).toUpperCase() + detalhes.slice(1)}.`;
    if (o.horaFinal) frase += ` Saída às ${o.horaFinal}h.`;
    return frase;
}

function classificarMensagem(textoOriginal, navios = NAVIOS_PADRAO, horaMensagem = '') {
    const texto = normalizarTexto(textoOriginal);
    const n = semAcento(texto).toLowerCase().trim();
    const campos = extrairCampos(texto, navios);
    const padrao = lerMensagemPadrao(texto);
    const base = { ruido: false, urgente: false, sugestao: 'ATIVIDADE', campos, estruturada: padrao.estruturada, rascunhos: [] };

    if (n.length < 4 || RE_RUIDO.test(n) || !/[a-z0-9]/.test(n)) return { ...base, ruido: true, sugestao: 'IGNORAR' };
    if (RE_URGENTE.test(n)) return { ...base, urgente: true, sugestao: 'OCORRENCIA' };

    const ehOperacao = RE_OPERACAO.test(n) || (padrao.estruturada && /provis|fornecimento|entrega/.test(semAcento(padrao.titulo).toLowerCase()));
    if (ehOperacao) return { ...base, sugestao: 'OPERACAO', rascunhos: rascunhosOperacao(texto, horaMensagem, navios) };
    if (RE_SAIDA.test(n) && campos.placa) return { ...base, sugestao: 'SAIDA' };
    if (RE_OCORRENCIA.test(n)) return { ...base, sugestao: 'OCORRENCIA' };
    if (RE_DIGITAL.test(n)) return { ...base, sugestao: 'DIGITAL' };
    if (RE_NAVIO.test(n)) return { ...base, sugestao: 'NAVIO' };
    if (RE_AVISO.test(n)) return { ...base, sugestao: 'AVISO' };
    return base;
}

// ---------------------------------------------------------------------
// Modelos de e-mail das operações de bordo
// ---------------------------------------------------------------------
function saudacao(horaNum) {
    if (horaNum >= 5 && horaNum < 12) return 'Prezados, bom dia!';
    if (horaNum >= 12 && horaNum < 18) return 'Prezados, boa tarde!';
    return 'Prezados, boa noite!';
}

function hh(h, vazio = 'Em andamento') { const n = normalizarHora(h); return n ? `${n}h` : vazio; }

function minutaEmail(op) {
    const t = agora();
    const data = op.data || t.data;
    const tipoInfo = TIPOS_OPERACAO[op.tipo] || TIPOS_OPERACAO.OUTRA;
    const sa = v => (v && String(v).trim()) || 'S/A';
    const M = v => sa(v).toUpperCase();
    const veiculo = `${M(op.veiculo)}${op.placa ? ' - Placa ' + op.placa.toUpperCase() : ''}`;
    const assunto = `${tipoInfo.assunto} - ${(op.navio || 'NAVIO').toUpperCase()} - ${(op.terminal || '').toUpperCase()} - ${data.replace(/\//g, '-')}`;
    const L = linhas => linhas.map(l => `\t✓ ${l}`).join('\n');
    const horarios = `Horário inicial: ${hh(op.horaInicial, 'Não informado')}                              Horário final: ${hh(op.horaFinal)}`;
    const autoridade = op.autoridades || tipoInfo.autoridade;
    const terminalAut = op.autorizadoTerminal || '';
    let corpo;

    if (op.tipo === 'TRIPULACAO') {
        corpo = 'Registro a movimentação de tripulação:\n\n' + L([
            `Data: ${data}`, `Navio: ${M(op.navio)}`, `Terminal: ${sa(op.terminal)}`,
            `Quantos: ${formatarQtdTripulantes(op.quantidade)}`, `Embarque ou desembarque: ${sa(op.movimento)}`, horarios,
            `Empresa responsável/ Agência: ${M(op.empresa)}`,
            `Agente/ Motorista autorizado responsável: ${M(op.responsavel)}`,
            `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${autoridade}`, `Autorizados por (Terminal): ${terminalAut}`,
            `Observações: ${sa(op.observacoes)}`, `Status: ${op.status || 'Sem alteração'}`,
            `Procedimentos de segurança realizados: ${PROC_TRIPULACAO}`, 'Evidências: Em anexo'
        ]);
    } else {
        corpo = 'Registro o fornecimento de bordo:\n\n' + L([
            `Tipo: ${tipoInfo.tipo}`, `Data: ${data}`, horarios, `Terminal: ${sa(op.terminal)}`, `Navio: ${M(op.navio)}`,
            `Empresa responsável/ Fornecedor: ${M(op.empresa)}`,
            `Motorista/ Ajudante: ${M(op.responsavel)}${op.ajudante ? ' / ' + op.ajudante.toUpperCase() : ''}`,
            `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${autoridade}`, `Autorizados por (Terminal): ${terminalAut}`,
            `Observações: ${sa(op.observacoes)}`,
            `Procedimentos de segurança realizados: ${PROC_FORNECIMENTO}`,
            `Status: ${op.status || 'Sem alteração'}`, 'Evidências: Em anexo'
        ]);
    }

    corpo = `${saudacao(t.horaNum)}\n\n${corpo}\n\nInformo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
    return { assunto, corpo };
}

function ehMensagemDeSaida(texto) {
    return RE_SAIDA.test(semAcento(normalizarTexto(texto)).toLowerCase());
}

module.exports = {
    ehMensagemDeSaida, TIPOS_OPERACAO, MOVIMENTOS, NAVIOS_PADRAO,
    fichaVazia, naviosDeTexto, adicionarLinhaNavio, ehRelatorioDeTurno, lerRelatorio, fichaHerdada,
    formatarRelatorio, conferirFicha, formatarPassagemEscala, textoAviso,
    lerMensagemPadrao, classificarMensagem, extrairCampos, rascunhosOperacao, atividadeDasOperacoes,
    tipoOperacaoDoTexto, movimentoDoTexto, resumoNavio, minutaEmail, numeroKm, navioConhecido, terminalDoNavio,
    formatarQtdTripulantes, ehSemAlteracao
};

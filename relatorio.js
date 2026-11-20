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
    agora, turnoPelaHora, dataDoTurno, diaSeguinte, dataDeOntem, novoId, semAcento, limparMarcador,
    normalizarHora, normalizarPlaca, lerPlacas, normalizarTerminal, normalizarTexto
} = require('./util');

// ---------------------------------------------------------------------
// Tipos de operação de bordo
// ---------------------------------------------------------------------
const PROC_TRIPULACAO = '(Identificação, verificação das autorizações, Briefing de segurança, inspeções, acompanhamento e monitoramento).';
const PROC_FORNECIMENTO = '(Identificação, verificação das autorizações, Check List, Briefing de segurança, conferência das Notas Fiscais, inspeções, acompanhamento e monitoramento).';

const TIPOS_OPERACAO = {
    TRIPULACAO: { rotulo: 'Movimentação de tripulantes', linha: 'Movimentação de tripulantes', assunto: 'MOVIMENTAÇÃO DE TRIPULAÇÃO', tipo: 'Movimentação de tripulação', autoridade: 'Polícia Federal' },
    RANCHO: { rotulo: 'Fornecimento de rancho', linha: 'Entrega de rancho', assunto: 'FORNECIMENTO DE RANCHO', tipo: 'Rancho', resumo: 'Fornecimento de Rancho.' },
    MATERIAIS: { rotulo: 'Materiais e equipamentos', linha: 'Entrega de materiais e equipamentos', assunto: 'FORNECIMENTO DE MATERIAIS E EQUIPAMENTOS', tipo: 'Materiais e equipamentos', resumo: 'Fornecimento de Materiais.' },
    DTA: { rotulo: 'DTA', linha: 'Entrega de DTA', assunto: 'FORNECIMENTO DE DTA', tipo: 'DTA', resumo: 'Fornecimento de DTA.' },
    AGUA: { rotulo: 'Água potável', linha: 'Entrega de água potável', assunto: 'FORNECIMENTO DE ÁGUA POTÁVEL', tipo: 'Água potável', resumo: 'Fornecimento de Água Potável.' },
    COMBUSTIVEL: { rotulo: 'Combustível', linha: 'Abastecimento de combustível', assunto: 'ABASTECIMENTO DE COMBUSTÍVEL', tipo: 'Combustível', resumo: 'Abastecimento de Combustível.' },
    RESIDUOS: { rotulo: 'Retirada de resíduos', linha: 'Retirada de resíduos', assunto: 'RETIRADA DE RESÍDUOS', tipo: 'Retirada de resíduos', resumo: 'Retirada de Resíduos.' },
    K9: { rotulo: 'Inspeção K9', linha: 'Inspeção K9', assunto: 'INSPEÇÃO K9', tipo: 'Inspeção K9', resumo: 'Inspeção K9.' },
    MERGULHO: { rotulo: 'Mergulho', linha: 'Inspeção submarina (mergulho)', assunto: 'INSPEÇÃO SUBMARINA - MERGULHO', tipo: 'Inspeção submarina (mergulho)', resumo: 'Inspeção submarina (mergulho).' },
    LACRE: { rotulo: 'Lacre / deslacração', linha: 'Lacre / deslacração', assunto: 'LACRE - DESLACRAÇÃO', tipo: 'Lacre / deslacração', resumo: 'Lacre / deslacração.' },
    OUTRA: { rotulo: 'Outra operação', linha: 'Operação de bordo', assunto: 'OPERAÇÃO DE BORDO', tipo: 'Operação de bordo', resumo: 'Operação de bordo.' }
};
for (const t of Object.values(TIPOS_OPERACAO)) if (!t.autoridade) t.autoridade = 'Receita Federal';

const MOVIMENTOS = ['Embarque', 'Desembarque', 'Embarque e Desembarque', 'Embarque definitivo', 'Desembarque definitivo', 'Saída a passeio', 'Saída para atendimento médico'];

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
    if (/\bRETORN(O|OU|ARAM|AM)\b|\bVOLT(OU|ARAM)\b/.test(n) && !/\bSAIDA\b/.test(n)) return 'Retorno';
    if (/PASSEIO|SHORE LEAVE/.test(n)) return 'Saída a passeio';
    const des = /DESEMBARQUE/.test(n);
    const emb = /\bEMBARQUE/.test(n.replace(/DESEMBARQUE/g, ''));
    const definitivo = /DEFINITIV/.test(n);
    if (des && emb) return 'Embarque e Desembarque';
    if (des) return definitivo ? 'Desembarque definitivo' : 'Desembarque';
    if (emb) return definitivo ? 'Embarque definitivo' : 'Embarque';
    return '';
}

function formatarQtdTripulantes(q) {
    const n = parseInt(String(q || '').replace(/\D/g, ''), 10);
    if (!n) return '01 tripulante';
    return `${String(n).padStart(2, '0')} tripulante${n === 1 ? '' : 's'}`;
}

// Linha da seção 6 para uma operação (padrão do robô antigo)
// ---------------------------------------------------------------------
// Nomes das equipes (seção 8)
// ---------------------------------------------------------------------
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
function nomeProprio(n) {
    const orig = String(n || '').trim().replace(/\s+/g, ' ');
    const misto = /[a-zà-ÿ]/.test(orig);   // "Equipe US": mantém siglas; "GUSTAVO RAMOS": vira "Gustavo Ramos"
    return orig.split(' ').map((w, i) => {
        if (misto && w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
        const p = w.toLowerCase();
        return (i && PARTICULAS.has(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' ');
}
function separarNomes(texto) {
    const t = String(texto || '').replace(/[*_✓✔•]/g, ' ').trim();
    if (!t || /conforme\s+escala/i.test(semAcento(t))) return [];
    return t.split(/\s*(?:,|;|\/|\n|\s+e\s+|\s+&\s+)\s*/i).map(nomeProprio).filter(n => n.length >= 2);
}
function juntarNomes(lista) {
    const l = (lista || []).filter(Boolean);
    return l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}` : (l[0] || '');
}
// Opção 3: "Saindo | Assumindo" — o pipe é obrigatório
function lerEquipesComPipe(texto) {
    const partes = String(texto || '').split('|');
    if (partes.length !== 2) throw new Error('Use o separador "|" uma única vez: Equipe saindo | Equipe assumindo');
    const [saindo, assumindo] = partes.map(x => x.trim());
    if (!saindo || !assumindo) throw new Error('Preencha os dois lados do "|": Equipe saindo | Equipe assumindo');
    return { saindo, assumindo, saindoLista: separarNomes(saindo), assumindoLista: separarNomes(assumindo) };
}

// Linha da operação dentro do navio (seção 6). Sucinta e sem horário:
// horário só nas manobras (atracação/desatracação) e previsões. Empresa, motorista, placa etc. ficam na operação e vão no e-mail.
//   "Embarque de 01 tripulante."            (concluída)
//   "Embarque de 01 tripulante. Em andamento."
//   "Saída a passeio de 05 tripulantes. Não retornaram até o presente momento."
//   "Entrega de rancho. Em andamento."
function ehSaidaDeTripulantes(op) {
    return op.tipo === 'TRIPULACAO' && /^Sa[ií]da/i.test(op.movimento || '');
}
function resumoNavio(op) {
    const concluida = !!op.horaFinal;
    if (op.tipo === 'TRIPULACAO') {
        const voltou = !!op.horaRetorno;   // saída a passeio/médico só termina quando os tripulantes retornam
        const n = parseInt(String(op.quantidade || '').replace(/\D/g, ''), 10) || 1;
        let linha = op.qtdEmbarque && op.qtdDesembarque
            ? `Embarque de ${String(+op.qtdEmbarque).padStart(2, '0')} e desembarque de ${formatarQtdTripulantes(op.qtdDesembarque)}.`
            : `${op.movimento || 'Embarque'} de ${formatarQtdTripulantes(op.quantidade)}.`;
        if (ehSaidaDeTripulantes(op)) {
            linha += voltou ? (n === 1 ? ' Retornou ao terminal.' : ' Retornaram ao terminal.')
                : (n === 1 ? ' Não retornou até o presente momento.' : ' Não retornaram até o presente momento.');
        } else if (!concluida) linha += ' Em andamento.';
        return linha;
    }
    const tipo = TIPOS_OPERACAO[op.tipo] || TIPOS_OPERACAO.OUTRA;
    return `${tipo.linha}.${concluida ? '' : ' Em andamento.'}`;
}

const RE_PREFIXO_NAVIO = /^(?:M\s*\/\s*V|M\.\s*V\.?|MV|N\s*\/\s*M|NM|NAVIO)\b\s*[-–:.]?\s*/i;
function nomeNavioLimpo(nome) {
    return String(nome || '').trim().replace(RE_PREFIXO_NAVIO, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
function chaveNavio(nome) {
    return semAcento(nomeNavioLimpo(semAcento(nome))).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function distancia(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
// Acha o navio cadastrado a partir de um nome digitado (tolera prefixo MV, acento, espaço e 1–2 letras erradas)
function acharNavio(nome, navios = NAVIOS_PADRAO) {
    const k = chaveNavio(nome);
    if (k.length < 3) return null;
    const exato = navios.find(n => chaveNavio(n.nome) === k);
    if (exato) return exato;
    const tol = k.length >= 10 ? 2 : k.length >= 5 ? 1 : 0;
    let melhor = null, menor = 99;
    for (const n of navios) {
        const dd = distancia(chaveNavio(n.nome), k);
        if (dd < menor) { menor = dd; melhor = n; }
    }
    return menor <= tol ? melhor : null;
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
        equipes: { modo: 'ESCALA', saindo: 'Conforme escala', assumindo: 'Conforme escala', saindoLista: [], assumindoLista: [] },
        anterior: null,   // { assumindo, kmFinal, turno, data } do turno anterior (opção Herança)
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

// repetir = true: operações diferentes podem ter o mesmo texto (ex.: dois "Embarque de 01 tripulante.")
function adicionarLinhaNavio(ficha, terminal, nomeNavio, linha, repetir = false) {
    const chave = terminal === 'T-OIL' ? 'toil' : 'tore';
    ficha.navios = ficha.navios || { tore: [], toil: [] };
    ficha.navios[chave] = ficha.navios[chave] || [];
    const alvo = chaveNavio(nomeNavio);
    let n = ficha.navios[chave].find(x => chaveNavio(x.navio) === alvo);
    if (!n) { n = { id: novoId(), navio: nomeNavio.toUpperCase(), linhas: [] }; ficha.navios[chave].push(n); }
    if (repetir || !n.linhas.includes(linha)) n.linhas.push(linha);
}

// Troca a linha de uma operação no navio (mantém a posição); se mudou de navio, tira do antigo e põe no novo
function trocarLinhaNavio(ficha, antes, depois) {
    const chave = t => (t === 'T-OIL' ? 'toil' : 'tore');
    if (antes?.linha) {
        const lista = ficha.navios?.[chave(antes.terminal)] || [];
        const n = lista.find(x => chaveNavio(x.navio) === chaveNavio(antes.navio));
        const i = n ? n.linhas.indexOf(antes.linha) : -1;
        if (i >= 0) {
            if (depois && chave(depois.terminal) === chave(antes.terminal) && chaveNavio(depois.navio) === chaveNavio(antes.navio)) {
                n.linhas[i] = depois.linha;
                return;
            }
            n.linhas.splice(i, 1);
        }
    }
    if (depois?.linha && depois.navio && depois.terminal) adicionarLinhaNavio(ficha, depois.terminal, depois.navio, depois.linha, true);
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

const INICIO_SECAO = /^(EFETIVO|VIATURA|VTR\b|SISTEMAS|ATIVIDADES|AVISOS|MOVIMENTACAO|NAVIOS|OCORRENCIA|PASSAGEM)/;
function secaoDaLinha(linha) {
    const n = normalizar(linha);
    const m = n.match(/^(\d)\s*[.\-)]\s*(.+)$/);
    if (m) {
        if (m[2].length > 60) return null;
        const s = SECOES.find(sec => sec.teste.test(m[2]));
        return s ? s.chave : null;
    }
    // relatórios sem numeração: "*EFETIVO CCOS*", "ATIVIDADES REALIZADAS:", "PASSAGEM DE TURNO"
    const bruta = String(linha || '').trim();
    const cabecalho = /^\*[^*]+\*:?$/.test(bruta) || (bruta === bruta.toUpperCase() && /[A-Z]/.test(n));
    const nome = n.replace(/:$/, '').trim();
    if (!cabecalho || nome.length > 50 || !INICIO_SECAO.test(nome)) return null;
    const s = SECOES.find(sec => sec.teste.test(nome));
    return s ? s.chave : null;
}

// Versão tolerante para relatórios antigos (sem numeração das seções, títulos diferentes)
const MARCAS_RELATORIO = [/EFETIVO/, /VIATURA|\bVTR\b|\bKM\b/, /SISTEMAS|CFTV|\bOCR\b/, /ATIVIDADES/, /AVISOS/, /NAVIO|MOVIMENTACAO/, /OCORRENCIA/, /PASSAGEM|EQUIPE (SAINDO|ASSUMINDO)/];
function ehRelatorioFlexivel(texto) {
    if (ehRelatorioDeTurno(texto)) return true;
    if (!texto || texto.length < 200) return false;
    const n = normalizar(texto);
    const topo = String(texto).split('\n').slice(0, 6).map(normalizar).join(' ');
    if (!/RELATORIO (DO |DE )?(TURNO|PLANTAO|SERVICO)|RELATORIO (DIURNO|NOTURNO)/.test(topo)) return false;
    return MARCAS_RELATORIO.filter(re => re.test(n)).length >= 3;
}
function turnoDoTexto(texto) {
    const topo = String(texto || '').split('\n').slice(0, 6).map(normalizar).join(' ');
    return /NOTURNO/.test(topo) ? 'NOTURNO' : /DIURNO/.test(topo) ? 'DIURNO' : '';
}
function dataDoTexto(texto) {
    const m = String(texto || '').split('\n').slice(0, 8).join(' ').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return '';
    const a = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${a}`;
}

function ehRelatorioDeTurno(texto) {
    if (!texto || typeof texto !== 'string' || texto.length < 80) return false;
    const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
    const topo = linhas.slice(0, 6).map(normalizar).join(' ');
    if (!/RELATORIO (DO |DE )?(TURNO|PLANTAO|SERVICO)|RELATORIO (DIURNO|NOTURNO)/.test(topo)) return false;
    const secoes = new Set(linhas.map(secaoDaLinha).filter(Boolean));
    return secoes.size >= 3;
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

    for (const l of linhas.slice(0, 6)) {
        const mt = normalizar(l).match(/\b(DIURNO|NOTURNO)\b/);
        if (mt && !dados.turno) dados.turno = mt[1];
        const md = l.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/);
        if (md && !dados.data) dados.data = `${md[1].padStart(2, '0')}/${md[2].padStart(2, '0')}/${md[3].length === 2 ? '20' + md[3] : md[3]}`;
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
                a.texto = resto.length ? resto.join('\n') : (primeira.includes(':') ? primeira.split(':').slice(1).join(':').trim() : '');
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

    // Opção HERANÇA: quem assumiu o turno anterior é a equipe saindo agora; a equipe assumindo é escolhida nos botões
    const saindoLista = separarNomes(d.equipes.assumindo || '');
    nova.equipes = saindoLista.length
        ? { modo: 'HERANCA', saindo: juntarNomes(saindoLista), assumindo: '', saindoLista, assumindoLista: [] }
        : { modo: 'ESCALA', saindo: 'Conforme escala', assumindo: 'Conforme escala', saindoLista: [], assumindoLista: [] };
    nova.anterior = { assumindo: d.equipes.assumindo || '', kmFinal: km, turno: d.turno || '', data: d.data || '' };
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
        '',
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
    [/^tipo( de operacao| de fornecimento| de provisao)?$/, 'tipo'],
    [/^terminal$/, 'terminal'],
    [/^(navio|navios|embarcacao|mv)$/, 'navio'],
    [/^(empresa|empresas|empresa responsavel|agencia|agencia maritima|fornecedor|fornecedora|prestador)$/, 'empresa'],
    [/^(motorista|motoristas|motorista autorizado|motoristas autorizados|condutor|condutores|responsavel)$/, 'responsavel'],
    [/^(agente|agentes|agente autorizado|agente responsavel|agente maritimo)$/, 'agente'],
    [/^(ajudante|ajudantes|auxiliar|auxiliares)$/, 'ajudante'],
    [/^((ajudantes? |tripulantes? |pessoas? )?a bordo)$/, 'aBordo'],
    [/^(veiculo|veiculos|veiculo utilizado|carro|caminhao)$/, 'veiculo'],
    [/^(placa|placas)$/, 'placa'],
    [/^(entrada|entrada (na |da )?portaria|horario (inicial|de entrada)|hora (inicial|de entrada|entrada)|inicio|chegada)$/, 'horaInicial'],
    [/^(saida|saida (na |da )?portaria|horario (final|de saida)|hora (final|de saida|saida)|termino)$/, 'horaFinal'],
    [/^(quantidade|quantos|qtd|qtde|tripulantes|n de tripulantes|quantidade de tripulantes|qtd de tripulantes)$/, 'quantidade'],
    [/^(movimento|embarque ou desembarque|movimentacao|tipo de movimentacao|tipo de movimento)$/, 'movimento'],
    [/^(embarque|embarques|qtd embarque|qtd de embarque|quantidade de embarque)$/, 'qtdEmbarque'],
    [/^(desembarque|desembarques|qtd desembarque|qtd de desembarque|quantidade de desembarque)$/, 'qtdDesembarque'],
    [/^(berco|lado do berco|costado)$/, 'berco'],
    [/^(bordo|lado)$/, 'bordo'],
    [/^(observacao|observacoes|obs)$/, 'observacoes'],
    [/^(autorizado por|autorizados por|autoridade|autoridades|autorizado por autoridades|autorizacao)$/, 'autoridades']
];
// Linhas sem rótulo logo abaixo destes campos continuam o campo (ex.: 2º ajudante na linha de baixo)
const CONTINUAVEIS = { ajudante: ', ', responsavel: ' / ', agente: ' / ', aBordo: ', ', observacoes: ' ', empresa: ' ', placa: ' / ', veiculo: ' / ' };
// Campos que podem aparecer mais de uma vez na mensagem (o valor novo é somado, nunca descartado)
const SEPARADOR_REPETIDO = { ajudante: ', ', aBordo: ', ', responsavel: ' / ', agente: ' / ', placa: ' / ', veiculo: ' / ', empresa: ' / ', observacoes: ' ' };
// "A BORDO" escrito no meio de outro campo (ex.: "AJUDANTES: JOÃO, GUSTAVO *A BORDO* MYCAION REIS")
const RE_A_BORDO = /(?:^|[\s,;\/])A\s+BORDO\s*[:\-]?\s*/i;

function lerMensagemPadrao(textoOriginal) {
    const texto = normalizarTexto(textoOriginal);
    const campos = {};
    const navios = [];
    const extras = [];      // linhas que o robô não reconheceu: vão inteiras para "Observações" do e-mail
    let titulo = '';
    let reconhecidos = 0;
    let ultimo = null;
    const somar = (chave, valor) => {
        valor = String(valor || '').replace(/\s+/g, ' ').replace(/^[\s,;\/]+|[\s,;\/]+$/g, '').trim();
        if (!valor) return;
        if (campos[chave] === undefined || campos[chave] === '') { campos[chave] = valor; return; }
        const ja = semAcento(campos[chave]).toUpperCase().replace(/\W/g, '');
        if (ja.includes(semAcento(valor).toUpperCase().replace(/\W/g, ''))) return;   // repetido igual: não duplica
        campos[chave] += (SEPARADOR_REPETIDO[chave] || ' / ') + valor;
    };
    const guardar = (chave, valor) => {
        const ab = String(valor).match(RE_A_BORDO);
        if (ab && chave !== 'aBordo' && chave !== 'observacoes') {
            somar(chave, valor.slice(0, ab.index));
            somar('aBordo', valor.slice(ab.index + ab[0].length));
            return 'aBordo';   // a próxima linha sem rótulo continua o "a bordo"
        }
        somar(chave, valor);
        return chave;
    };
    for (const bruta of texto.split('\n')) {
        const linha = bruta.replace(/[*_~]/g, '').replace(/^[-•✓✔]\s*/, '').replace(/\s+/g, ' ').trim();
        if (!linha) { ultimo = null; continue; }
        const m = linha.match(/^([A-Za-zÀ-ÿº°\/ .()]{2,40}?)\s*:\s*(.*)$/);
        const rot = m ? semAcento(m[1]).toLowerCase().replace(/[().º°]/g, '').replace(/\s+/g, ' ').trim() : '';
        const achado = m ? ROTULOS.find(([re]) => re.test(rot)) : null;
        if (!achado) {
            const soAbordo = linha.match(/^A\s+BORDO\s*[:\-]?\s*(.+)$/i);
            if (soAbordo) { reconhecidos++; ultimo = 'aBordo'; somar('aBordo', soAbordo[1]); continue; }
            if (!titulo && !reconhecidos) { titulo = linha; continue; }
            if (!m && ultimo && CONTINUAVEIS[ultimo]) {
                // nome quebrado na linha ("FERNANDO" + "QUEROZ / WALQUER"): a última parte tem uma palavra só → continua o mesmo nome
                const atual = campos[ultimo] || '';
                const ultimaParte = atual.split(/\s*(?:,|\/|;)\s*/).pop() || '';
                if (atual && /^[A-Za-zÀ-ÿ]+$/.test(ultimaParte.trim()) && !/[,\/;]\s*$/.test(atual) && ['responsavel', 'agente', 'ajudante', 'aBordo'].includes(ultimo)) {
                    campos[ultimo] = atual + ' ';
                    const [primeira, ...resto] = linha.split(/(?=\s*[,\/;])/);
                    campos[ultimo] += primeira.trim();
                    if (resto.length) guardar(ultimo, resto.join('').replace(/^\s*[,\/;]\s*/, ''));
                } else ultimo = guardar(ultimo, linha);
                continue;
            }
            extras.push(linha);
            ultimo = null;
            continue;
        }
        reconhecidos++;
        const chave = achado[1];
        ultimo = chave;
        const valor = m[2].trim();
        if (chave === 'navio') {
            const limpo = valor.replace(RE_PREFIXO_NAVIO, '');
            limpo.split(/\s*(?:,|;|\s+\/\s+|\s+e\s+)\s*/i).map(v => nomeNavioLimpo(v)).filter(Boolean).forEach(v => { if (!navios.includes(v)) navios.push(v); });
        } else ultimo = guardar(chave, valor);
    }
    return { estruturada: reconhecidos >= 3, titulo, campos, navios, extras };
}

// ---------------------------------------------------------------------
// Classificação das mensagens (sugestão de destino)
// ---------------------------------------------------------------------
const RE_RUIDO = /^(bom dia|boa tarde|boa noite|ok|okay|blz|beleza|valeu|vlw|obrigad[oa]|grato|ciente|recebido|show|top|joia|tmj|positivo|copiado|qsl|sim|nao|opa|ola|oi|bom plantao|boa folga|bom descanso|amem|kkk+|rs+|ha(ha)+)(\s+(a todos|pessoal|equipe|galera|irmao|chefe))?[\s!.,]*$/;
const RE_URGENTE = /\b(acidente|incendio|fogo|ferid[oa]s?|ambulancia|vazamento|invasao|socorrid[oa]|alagamento|sinistro|colisao|obito|afogamento|explosao|disparo|arma de fogo|emergencia)\b/;
const RE_OCORRENCIA = /\b(avaria|danificad[oa]|quebr(ou|ado|ada)|furto|roubo|arrombamento|apreensao|inconformidade|irregularidade|recusad[oa]|barrad[oa]|sem autorizacao|nao autorizad[oa]|arriada)\b/;
const RE_OPERACAO = /\b(rancho|provis(ao|oes)|tripulantes?|tripulacao|residuos?|agua potavel|bunker|combustivel|dta|pecas de bordo|sobressalentes|k9|mergulho|lacre|deslacracao)\b/;
const RE_DIGITAL = /\b(digital|spda|dps|cftv|cameras?|fibra|nobreak|postes?|filtragem)\b/;
const RE_NAVIO = /\b(atracad[oa]|desatracad[oa]|atracacao|desatracacao|fundead[oa]|fundeio|pratico|eta|etb|etd|amarrad[oa]|em manobra)\b/;
const RE_AVISO = /\b(acompanhar|atentar|programad[oa] para|aguardando|pendente|previsto para|prevista para|amanha|verificar)\b/;
const RE_SAIDA = /\b(saida|saiu|deixou o terminal|liberad[oa] na saida)\b/;

function navioConhecido(texto, navios = NAVIOS_PADRAO) {
    const n = semAcento(texto).toUpperCase();
    for (const nav of navios) {
        const nome = semAcento(nomeNavioLimpo(nav.nome));
        if (nome && new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`).test(n)) return nav;
    }
    return null;
}

function terminalDoNavio(nome, navios = NAVIOS_PADRAO) {
    return navioConhecido(nome, navios)?.terminal || '';
}

function extrairCampos(textoOriginal, navios = NAVIOS_PADRAO) {
    const t = normalizarTexto(textoOriginal);
    const navio = t.match(/\b(?:NAVIO|M\/V|MV)\s*[-–:]?\s*(?:(?:M\/V|MV|NM)\s*[-–.]?\s*)?([A-Z0-9][A-Z0-9 .]{2,30}?)(?=\s*[-–:.,;(\n]|\s+T-|\s*$)/im);
    const qtd = t.match(/\b(\d{1,3})\s*tripulantes?\b/i);
    const conhecido = navioConhecido(t, navios);
    // "AMETISTA BRASIL – T-OIL. ..." : nome em maiúsculas antes do terminal
    const antesDoTerminal = t.match(/^\s*([A-Z0-9][A-Z0-9 .'\/-]{2,40}?)\s*[-–]\s*T[\s.\-]?(?:ORE|OIL)\b/m);
    return {
        placa: normalizarPlaca(t),
        navio: navio ? navio[1].trim().toUpperCase() : (conhecido ? nomeNavioLimpo(conhecido.nome) : (antesDoTerminal ? nomeNavioLimpo(antesDoTerminal[1]) : '')),
        terminal: normalizarTerminal(t) || conhecido?.terminal || '',
        hora: normalizarHora(t),
        quantidade: qtd ? qtd[1].padStart(2, '0') : '',
        movimento: movimentoDoTexto(t)
    };
}

// Todos os horários escritos no texto ("10:48", "14:50Hs", "14h45")
function horasDoTexto(t) {
    const out = [];
    const re = /(?<!\d)([01]?\d|2[0-3])\s*[:hH]\s*([0-5]\d)(?!\d)/g;
    let m;
    while ((m = re.exec(String(t || '')))) { const h = `${m[1].padStart(2, '0')}:${m[2]}`; if (!out.includes(h)) out.push(h); }
    return out;
}

// Rascunhos de operação (um por navio) a partir de uma mensagem.
// Regra: o que está escrito na mensagem manda. Nada é descartado.
//   conferir[] → impede o registro automático (fica "a confirmar" para o líder decidir)
//   alertas[]  → só avisa (não bloqueia)
function rascunhosOperacao(textoOriginal, horaMensagem, navios = NAVIOS_PADRAO) {
    const texto = normalizarTexto(textoOriginal);
    const p = lerMensagemPadrao(texto);
    const c = p.campos;
    const livre = extrairCampos(texto, navios);
    const tipo = tipoOperacaoDoTexto(`${c.tipo || ''} ${p.titulo} ${texto}`);
    const listaNavios = p.navios.length ? p.navios : (livre.navio ? [livre.navio] : ['']);
    const terminalEscrito = normalizarTerminal(c.terminal || '') || normalizarTerminal(texto);
    const qtd = c.quantidade || livre.quantidade;
    // "embarque de 13 e desembarque de 14": as duas quantidades separadas (a planilha tem uma coluna para cada)
    const num = v => { const n = parseInt(String(v || '').replace(/\D/g, ''), 10); return n ? String(n).padStart(2, '0') : ''; };
    const qE = num(c.qtdEmbarque) || num((texto.match(/(?<!des)embarque\s+(?:definitivo\s+)?(?:de\s+)?(\d{1,3})/i) || [])[1]);
    const qD = num(c.qtdDesembarque) || num((texto.match(/desembarque\s+(?:definitivo\s+)?(?:de\s+)?(\d{1,3})/i) || [])[1]);
    const ambos = !!(qE && qD);
    // inspeção de caixa de mar (T-ORE): berço Leste/Oeste e bordo E (estibordo) / B (bombordo)
    const nTxt = semAcento(`${c.berco || ''} ${c.bordo || ''} ${texto}`).toUpperCase();
    const berco = /\bLESTE\b/.test(nTxt) ? 'LESTE' : /\bOESTE\b/.test(nTxt) ? 'OESTE' : '';
    const bordo = /ESTIBORDO|BORESTE|\bBORDO:?\s*E\b/.test(nTxt) ? 'E' : /BOMBORDO|\bBORDO:?\s*B\b/.test(nTxt) ? 'B' : '';
    const placas = lerPlacas(c.placa || '');
    const placa = placas.texto || livre.placa;
    const horas = horasDoTexto(texto);

    const alertasBase = [];
    const conferirBase = [];
    if (placas.incompletas.length) alertasBase.push(`Placa incompleta na mensagem: ${placas.incompletas.join(', ')} — conferir`);
    let horaInicial = normalizarHora(c.horaInicial || '');
    if (!horaInicial && !c.horaFinal) {
        if (horas.length === 1) horaInicial = horas[0];
        else if (horas.length > 1) { horaInicial = horas[0]; conferirBase.push(`Mensagem com mais de um horário (${horas.join(', ')}) — confirmar o horário de entrada`); }
        else if (horaMensagem) { horaInicial = horaMensagem; alertasBase.push(`Horário de entrada não estava na mensagem: usado o horário da postagem (${horaMensagem})`); }
    }
    // linhas não reconhecidas vão para Observações (nada se perde)
    const observacoes = [c.observacoes, ...(p.estruturada ? p.extras : [])].filter(Boolean).join('; ');

    const arrumar = v => String(v || '').toUpperCase().replace(/\s*\/\s*/g, ' / ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
    return listaNavios.map(nomeNavio => {
        const conhecido = nomeNavio ? acharNavio(nomeNavio, navios) : null;
        const nomeFinal = nomeNavioLimpo(conhecido ? conhecido.nome : nomeNavio);
        const conferir = [...conferirBase];
        const alertas = [...alertasBase];
        if (conhecido && chaveNavio(conhecido.nome) !== chaveNavio(nomeNavio))
            conferir.push(`Navio escrito "${nomeNavioLimpo(nomeNavio)}" é parecido com "${nomeFinal}" — confirmar o navio`);
        if (terminalEscrito && conhecido?.terminal && conhecido.terminal !== terminalEscrito)
            conferir.push(`Mensagem diz ${terminalEscrito}, mas o navio ${nomeFinal} está no ${conhecido.terminal} — confirmar o terminal`);
        const terminal = terminalEscrito || conhecido?.terminal || '';
        if (!terminal) conferir.push('Terminal não informado — confirmar');
        if (!nomeFinal) conferir.push('Navio não informado — confirmar');
        return {
            tipo,
            navio: nomeFinal,
            autoridades: c.autoridades || (TIPOS_OPERACAO[tipo] || TIPOS_OPERACAO.OUTRA).autoridade,
            terminal,
            empresa: arrumar(c.empresa),
            responsavel: arrumar(c.responsavel),
            agente: arrumar(c.agente),
            ajudante: arrumar(c.ajudante),
            aBordo: arrumar(c.aBordo),
            veiculo: arrumar(c.veiculo),
            placa,
            quantidade: tipo === 'TRIPULACAO' ? (ambos ? String(+qE + +qD).padStart(2, '0') : (qtd ? String(parseInt(qtd, 10) || '').padStart(2, '0') : (qE || qD))) : '',
            movimento: tipo === 'TRIPULACAO' ? (ambos ? 'Embarque e Desembarque' : c.movimento ? movimentoDoTexto(c.movimento) || c.movimento : movimentoDoTexto(texto) || 'Embarque') : '',
            qtdEmbarque: tipo === 'TRIPULACAO' && ambos ? qE : '',
            qtdDesembarque: tipo === 'TRIPULACAO' && ambos ? qD : '',
            berco: tipo === 'MERGULHO' ? berco : '',
            bordo: tipo === 'MERGULHO' ? bordo : '',
            horaInicial,
            horaFinal: normalizarHora(c.horaFinal || ''),
            observacoes,
            conferir,
            alertas
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
        o.ajudante ? `${/,| e /i.test(o.ajudante) ? 'ajudantes' : 'ajudante'} ${o.ajudante.replace(/,\s*([^,]+)$/, ' e $1')}` : '',
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
    if (ehOperacao) {
        const rascunhos = rascunhosOperacao(texto, horaMensagem, navios);
        // operações de bordo vão só para o navio (seção 6) e para o e-mail — nunca para as Atividades (seção 4)
        return { ...base, sugestao: 'OPERACAO', rascunhos, atividade: '' };
    }
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

// "CAMINHÃO / MOBI" + "GXM-8B67 / RBI-458" → "CAMINHÃO - Placa GXM-8B67 / MOBI - Placa RBI-458"
function veiculosComPlacas(veiculo, placa) {
    const vs = String(veiculo || '').toUpperCase().split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean);
    const ps = String(placa || '').toUpperCase().split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean);
    if (vs.length > 1 && vs.length === ps.length) return vs.map((v, i) => `${v} - Placa ${ps[i]}`).join(' / ');
    return `${vs.join(' / ') || 'S/A'}${ps.length ? ' - Placa ' + ps.join(' / ') : ''}`;
}
// Agente e motorista são pessoas diferentes: os dois vão no e-mail
function agenteEMotorista(op) {
    const ag = String(op.agente || '').trim().toUpperCase(), mo = String(op.responsavel || '').trim().toUpperCase();
    if (ag && mo) return `${ag} (AGENTE) / ${mo} (MOTORISTA)`;
    return ag || mo || 'S/A';
}
function observacoesEmail(op, fornecimento = false) {
    return [
        fornecimento && op.agente ? `Agente: ${String(op.agente).toUpperCase()}` : '',
        op.aBordo ? `A bordo: ${String(op.aBordo).toUpperCase()}` : '',
        op.horaRetorno ? `Retorno dos tripulantes ao terminal às ${op.horaRetorno}h` : '',
        op.observacoes
    ].filter(x => x && String(x).trim()).join('; ');
}

function minutaEmail(op) {
    const t = agora();
    const data = op.data || t.data;
    const tipoInfo = TIPOS_OPERACAO[op.tipo] || TIPOS_OPERACAO.OUTRA;
    const sa = v => (v && String(v).trim()) || 'S/A';
    const M = v => sa(v).toUpperCase();
    const veiculo = veiculosComPlacas(op.veiculo, op.placa);
    const assunto = `${tipoInfo.assunto} - ${(op.navio || 'NAVIO').toUpperCase()} - ${(op.terminal || '').toUpperCase()} - ${data.replace(/\//g, '-')}`;
    const L = linhas => linhas.map(l => `\t✓ ${l}`).join('\n');
    const horarios = `Horário inicial: ${hh(op.horaInicial, 'Não informado')}                              Horário final: ${hh(op.horaFinal)}`;
    const autoridade = op.autoridades || tipoInfo.autoridade;
    const terminalAut = op.autorizadoTerminal || '';
    let corpo;

    if (op.tipo === 'TRIPULACAO') {
        corpo = 'Registro a movimentação de tripulação:\n\n' + L([
            `Data: ${data}`, `Navio: ${M(op.navio)}`, `Terminal: ${sa(op.terminal)}`,
            `Quantos: ${op.qtdEmbarque && op.qtdDesembarque ? `${formatarQtdTripulantes(op.qtdEmbarque)} (embarque) / ${formatarQtdTripulantes(op.qtdDesembarque)} (desembarque)` : formatarQtdTripulantes(op.quantidade)}`, `Embarque ou desembarque: ${sa(op.movimento)}`, horarios,
            `Empresa responsável/ Agência: ${M(op.empresa)}`,
            `Agente/ Motorista autorizado responsável: ${agenteEMotorista(op)}`,
            `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${autoridade}`, `Autorizados por (Terminal): ${terminalAut}`,
            `Observações: ${sa(observacoesEmail(op))}`, `Status: ${op.status || 'Sem alteração'}`,
            `Procedimentos de segurança realizados: ${PROC_TRIPULACAO}`, 'Evidências: Em anexo'
        ]);
    } else {
        corpo = 'Registro o fornecimento de bordo:\n\n' + L([
            `Tipo: ${tipoInfo.tipo}`, `Data: ${data}`, horarios, `Terminal: ${sa(op.terminal)}`, `Navio: ${M(op.navio)}`,
            `Empresa responsável/ Fornecedor: ${M(op.empresa)}`,
            `Motorista/ Ajudante: ${M(op.responsavel)}${op.ajudante ? ' / ' + op.ajudante.toUpperCase() : ''}`,
            `Veículo utilizado: ${veiculo}`,
            `Autorizado por (Autoridades): ${autoridade}`, `Autorizados por (Terminal): ${terminalAut}`,
            `Observações: ${sa(observacoesEmail(op, true))}`,
            `Procedimentos de segurança realizados: ${PROC_FORNECIMENTO}`,
            `Status: ${op.status || 'Sem alteração'}`, 'Evidências: Em anexo'
        ]);
    }

    corpo = `${saudacao(t.horaNum)}\n\n${corpo}\n\nInformo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
    return { assunto, corpo };
}

// ---------------------------------------------------------------------
// Manobra informada no grupo ("Martha Oldendorff atracado às 10:42 T-ORE")
// → linha padronizada do navio na seção 6
// ---------------------------------------------------------------------
function manobraDoTexto(textoOriginal, navios = NAVIOS_PADRAO) {
    const texto = normalizarTexto(textoOriginal).replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
    const n = semAcento(texto).toLowerCase();
    const prev = /previs|previst|programad|\beta\b|\betb\b|\betd\b/.test(n);
    const des = /desatraca(d|cao|ou|r)/.test(n);
    let tipo = null;
    if (/em manobra/.test(n)) tipo = des ? 'MANOBRA_DES' : 'MANOBRA';
    else if (des) tipo = prev ? 'PREV_DESATRACACAO' : 'DESATRACACAO';
    else if (/\batraca(d|cao|ou|r)/.test(n)) tipo = prev ? 'PREV_ATRACACAO' : 'ATRACACAO';
    else if (/\bfunde(ad|io|ou)/.test(n)) tipo = 'FUNDEIO';
    if (!tipo) return null;
    const hora = normalizarHora(texto);
    const dm = texto.match(/(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?/);
    const data = dm ? `${dm[1].padStart(2, '0')}/${dm[2].padStart(2, '0')}` : '';
    const conhecido = navioConhecido(texto, navios);
    let navio = conhecido ? nomeNavioLimpo(conhecido.nome) : '';
    if (!navio) {
        const VERBO = '(?:foi\\s+|est[aá]\\s+|esta\\s+)?(?:atracad|desatracad|fundead|em manobra|com previs|previs|atraca[cç][aã]o|desatraca[cç][aã]o)';
        const m = texto.match(new RegExp(`(?:navio|m\\/v|mv)\\s*[-:]?\\s*([A-Za-z0-9][A-Za-z0-9 .'-]{2,40}?)\\s*(?=[-–,:(.]|\\s+(?:foi|est[aá]|atracad|desatracad|fundead|em manobra|com previs|previs|no t|t-?ore|t-?oil|t\\.)|$)`, 'i'))
            || texto.match(new RegExp(`^([A-Za-z0-9][A-Za-z0-9 .'-]{2,40}?)\\s*[-–,:]?\\s*${VERBO}`, 'i'))
            || texto.match(/(?:atraca[cç][aã]o|desatraca[cç][aã]o|manobra)\s+(?:conclu[ií]da\s+)?(?:do|da)\s+(?:navio\s+)?([A-Za-z0-9][A-Za-z0-9 .'-]{2,40}?)\s*(?=[-–,:(.]|\s+(?:às|as|em|no|para|t-?ore|t-?oil)\b|$)/i);
        if (m && !/^(navio|o navio|previs|atraca|desatraca)/i.test(m[1].trim())) navio = nomeNavioLimpo(m[1]).toUpperCase();
    }
    const terminal = normalizarTerminal(texto) || conhecido?.terminal || '';
    const d = data ? ` em ${data}` : '', h = hora ? ` às ${hora}` : '';
    const linha = {
        ATRACACAO: `Atracado${d}${h}.`, DESATRACACAO: `Desatracado${d}${h}.`, FUNDEIO: `Fundeado${d}${h}.`,
        MANOBRA: 'Em manobra de atracação.', MANOBRA_DES: 'Em manobra de desatracação.',
        PREV_ATRACACAO: `Previsão de atracação${d}${h}.`, PREV_DESATRACACAO: `Previsão de desatracação${d}${h}.`
    }[tipo];
    return { tipo, navio, terminal, hora, data, linha };
}

// ---------------------------------------------------------------------
// Mensagem padrão do grupo (o mesmo modelo que a equipe já usa).
// O robô lê este formato 100%: o app gera a mensagem a partir da operação.
// ---------------------------------------------------------------------
function terminalPonto(t) { return String(t || '').toUpperCase().replace('-', '.'); }
function mensagemPadrao(op) {
    const U = v => String(v || '').trim().toUpperCase();
    const hora = (h, suf) => { const n = normalizarHora(h); return n ? n + suf : ''; };
    if (op.tipo === 'TRIPULACAO') {
        const titulo = op.qtdEmbarque && op.qtdDesembarque
            ? `Embarque de ${String(+op.qtdEmbarque).padStart(2, '0')} e Desembarque de ${formatarQtdTripulantes(op.qtdDesembarque)}`
            : `${op.movimento || 'Embarque'} ${formatarQtdTripulantes(op.quantidade)}`;
        const l = [titulo.charAt(0).toUpperCase() + titulo.slice(1), ''];
        if (op.responsavel) l.push(`Motorista: ${U(op.responsavel)}`);
        if (op.empresa) l.push(`Empresa: ${U(op.empresa)}`);
        if (op.veiculo) l.push(`Veículo: ${U(op.veiculo)}`);
        if (op.placa) l.push(`Placa: ${U(op.placa)}`);
        if (op.agente) l.push(`Agente: ${U(op.agente)}`);
        l.push(`Navio: ${U(op.navio)}`, `Terminal: ${terminalPonto(op.terminal)}`);
        if (op.horaInicial) l.push(`Entrada na portaria: ${hora(op.horaInicial, 'Hs')}`);
        if (op.horaFinal) l.push(`Saída na portaria: ${hora(op.horaFinal, 'Hs')}`);
        if (op.horaRetorno) l.push(`Retorno: ${hora(op.horaRetorno, 'Hs')}`);
        if (op.observacoes) l.push(`Observações: ${op.observacoes}`);
        return l.join('\n');
    }
    const tipo = TIPOS_OPERACAO[op.tipo] || TIPOS_OPERACAO.OUTRA;
    const provisao = ['RANCHO', 'MATERIAIS', 'DTA', 'AGUA'].includes(op.tipo);
    const l = [`*${provisao ? 'ENTREGA DE PROVISÃO' : tipo.assunto}*`, `*Tipo:* ${U(tipo.tipo)}`, `*Terminal:* ${terminalPonto(op.terminal)}`, `*Navio:* ${U(op.navio)}`];
    if (op.empresa) l.push(`*Empresa:* ${U(op.empresa)}`);
    if (op.responsavel) l.push(`*Motoristas:* ${U(op.responsavel)}`);
    if (op.agente) l.push(`*Agente:* ${U(op.agente)}`);
    if (op.ajudante) l.push(`*Ajudantes:* ${U(op.ajudante)}`);
    if (op.aBordo) l.push(`*A bordo:* ${U(op.aBordo)}`);
    if (op.berco) l.push(`*Berço:* ${U(op.berco)}`);
    if (op.bordo) l.push(`*Bordo:* ${op.bordo === 'E' ? 'ESTIBORDO' : op.bordo === 'B' ? 'BOMBORDO' : U(op.bordo)}`);
    if (op.veiculo) l.push(`*Veículo:* ${U(op.veiculo)}`);
    if (op.placa) l.push(`*Placa:* ${U(op.placa)}`);
    if (op.horaInicial) l.push(`*Entrada Portaria:* ${hora(op.horaInicial, 'H')}`);
    if (op.horaFinal) l.push(`*Saída Portaria:* ${hora(op.horaFinal, 'H')}`);
    if (op.observacoes) l.push(`*Observações:* ${op.observacoes}`);
    return l.join('\n');
}

function ehMensagemDeSaida(texto) {
    // "Saída a passeio" / "saída para atendimento médico" é movimento de tripulante, não saída de veículo
    const n = semAcento(normalizarTexto(texto)).toLowerCase().replace(/saida\s+(a|para|ao)\s+(passeio|atendimento|hospital|medico)/g, '');
    return RE_SAIDA.test(n);
}

// Turno seguinte / anterior: DIURNO D → NOTURNO D → DIURNO D+1
function proximoTurno(turno, data) {
    return turno === 'DIURNO' ? { turno: 'NOTURNO', data } : { turno: 'DIURNO', data: diaSeguinte(data) };
}
function turnoAnterior(turno, data) {
    return turno === 'NOTURNO' ? { turno: 'DIURNO', data } : { turno: 'NOTURNO', data: dataDeOntem(data) };
}

// Converte qualquer relatório postado no grupo para o padrão do robô
function padronizarRelatorio(texto, extra = {}) {
    const { dados: d } = lerRelatorio(texto);
    const f = fichaVazia({});
    f.turno = d.turno || extra.turno || f.turno;
    f.data = d.data || extra.data || f.data;
    f.efetivo = d.efetivo || '✓ S/A';
    f.vtr = { modelo: d.vtr.modelo || '', placa: d.vtr.placa || '', kmInicial: d.vtr.kmInicial, kmFinal: d.vtr.kmFinal };
    f.sistemas = { cftv: d.sistemas.cftv || '', ca: d.sistemas.ca || '', ocrAssertividade: d.sistemas.ocrAssertividade || '', ocrLeituras: d.sistemas.ocrLeituras || '' };
    f.atividades = d.atividades.map(t => ({ id: novoId(), texto: t }));
    f.navios = d.navios;
    f.ocorrencias = d.ocorrencias.map(t => ({ id: novoId(), texto: t }));
    f.equipes = { saindo: d.equipes.saindo || '', assumindo: d.equipes.assumindo || '' };
    return formatarRelatorio(f, d.avisos);
}

// Linhas para o Excel a partir do texto do relatório: [seção, conteúdo]
function linhasExcel(texto) {
    const linhas = [];
    let secao = '', sub = '';
    for (const bruta of String(texto || '').replace(/\*/g, '').split('\n')) {
        const l = bruta.trim();
        if (!l) continue;
        if (/^RELAT[OÓ]RIO DO TURNO/i.test(l)) { linhas.push({ titulo: l, grande: true }); continue; }
        if (/^Data:/i.test(l)) { linhas.push(['Data', l.replace(/^Data:\s*/i, '')]); continue; }
        const sec = l.match(/^(\d)\.\s+(.+?):?$/);
        if (sec && l === l.toUpperCase()) { secao = `${sec[1]}. ${sec[2]}`; sub = ''; linhas.push({ titulo: secao }); continue; }
        if (l === l.toUpperCase() && /[A-Z]/.test(l) && l.length < 60 && !/^[✓✔•]/.test(l) && !/\d{2}:\d{2}/.test(l)) { sub = l.replace(/:$/, ''); continue; }
        const kv = l.match(/^([A-Za-zÀ-ÿ ]{2,30}):\s*(.+)$/);
        if (kv && !/^[✓✔•]/.test(l)) linhas.push([sub ? `${sub} · ${kv[1]}` : kv[1], kv[2]]);
        else linhas.push([sub || secao.replace(/^\d\.\s*/, ''), l.replace(/^[✓✔•]\s*/, '')]);
    }
    return linhas;
}

module.exports = {
    padronizarRelatorio, ehRelatorioFlexivel, turnoDoTexto, dataDoTexto,
    proximoTurno, turnoAnterior, linhasExcel,
    ehMensagemDeSaida, TIPOS_OPERACAO, MOVIMENTOS, NAVIOS_PADRAO,
    fichaVazia, naviosDeTexto, adicionarLinhaNavio, ehRelatorioDeTurno, lerRelatorio, fichaHerdada,
    formatarRelatorio, conferirFicha, formatarPassagemEscala, textoAviso,
    lerMensagemPadrao, classificarMensagem, extrairCampos, rascunhosOperacao, atividadeDasOperacoes,
    tipoOperacaoDoTexto, movimentoDoTexto, resumoNavio, minutaEmail, mensagemPadrao, manobraDoTexto, numeroKm, navioConhecido, terminalDoNavio,
    formatarQtdTripulantes, ehSemAlteracao, separarNomes, juntarNomes, nomeProprio, lerEquipesComPipe, nomeNavioLimpo, chaveNavio, acharNavio, trocarLinhaNavio
};

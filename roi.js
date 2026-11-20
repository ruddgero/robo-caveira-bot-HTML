// =====================================================================
// ROI · Relatório de Ocorrência Interna (CSE - Porto do Açu)
//  numeração automática NNN/AAAA (recomeça a cada ano, continua o controle anual)
//  rascunho → registrado (recebe número + linha no item 7) · cancelado (número fica reservado)
//  importação dos controles anuais (.xlsx) · Excel no modelo da equipe (com evidências fotográficas)
// =====================================================================
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { agora, novoId, semAcento } = require('./util');
const { zip, gerarXlsx } = require('./xlsx');
const { lerXlsx } = require('./xlsx_leitura');

const GRUPOS_ROI = {
    G1: 'Acidentes', G2: 'Quebra de procedimento', G3: 'Atos ilícitos',
    G4: 'Ameaças e agressões', G5: 'Ação preventiva', G6: 'Outros'
};
const MAX_FOTOS = 8;
const CONTROLE_INICIAL = { 2026: 30 };     // último número do controle anual entregue pela equipe (030/2026)

const estado = { rois: [], controle: { ...CONTROLE_INICIAL }, locais: {}, carregado: false };   // locais: grafia → nome confirmado
let marca = 0;
const nucleo = () => require('./nucleo');   // carregado sob demanda (evita dependência circular)

function erro(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const quem = u => (u ? { id: u.id, nome: u.nome } : { id: 'robo', nome: 'Robô' });
const limpo = v => String(v ?? '').replace(/\r/g, '').trim();

// ------------------------- Regras básicas -------------------------
const pad3 = n => String(n).padStart(3, '0');
function numeroRoi(seq, ano) { return `${pad3(seq)}/${ano}`; }
function lerNumero(txt) {
    const m = String(txt || '').match(/(\d{1,4})\s*\/\s*(\d{2,4})/);
    if (!m) return null;
    const ano = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return { seq: +m[1], ano };
}
function anoDaData(data) { const m = String(data || '').match(/\/(\d{4})$/); return m ? +m[1] : +agora().data.slice(6); }

function normalizarData(v) {
    const t = limpo(v);
    let m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3].length === 2 ? '20' + m[3] : m[3]}`;
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return t;
}

// "G5-Ação Preventiva", "G.1 Acidente", "G1A - Acidente", "G3 - Atos Ilícitos - SIMULADO" → G1..G6
function codigoDoTipo(texto, descricao = '') {
    const m = String(texto || '').match(/G\s*\.?\s*-?\s*([1-6])/i);
    if (m) return 'G' + m[1];
    const n = semAcento(`${texto} ${descricao}`).toLowerCase();
    if (/acidente|colis|abalroa|avaria|danos? (em|ao|a)/.test(n)) return 'G1';
    if (/quebra de procedimento|procedimento|sem autoriza|nao autoriza|tentativa de (saida|acesso)|bebida|alcool/.test(n)) return 'G2';
    if (/ilicit|furto|roubo|entorpecente|droga|arromb|invas/.test(n)) return 'G3';
    if (/ameaca|agress/.test(n)) return 'G4';
    if (/preventiva|destrancad|aberta|vulnerab|sem cadeado/.test(n)) return 'G5';
    return texto || descricao ? 'G6' : '';
}
const ehSimulado = (...t) => t.some(x => /simulad/i.test(semAcento(x || '')));

// Sugestão de grupo pelo texto de uma mensagem/ocorrência
function adivinharTipo(texto) {
    const n = semAcento(texto).toLowerCase();
    if (/acidente|colis|abalroa|bateu|atingiu|atinge|rompe|tombamento|queda de|danific|avaria/.test(n)) return 'G1';
    if (/furto|roubo|entorpecente|droga|ilicit|arromb|invas|subtra/.test(n)) return 'G3';
    if (/ameaca|agress|briga|xinga/.test(n)) return 'G4';
    if (/quebra de procedimento|sem autoriza|nao autoriza|tentativa de (saida|acesso)|bebida|alcool|recusad|barrad/.test(n)) return 'G2';
    if (/destrancad|porta aberta|janela aberta|vulnerav|preventiva|sem cadeado|material exposto/.test(n)) return 'G5';
    return 'G6';
}

const rotuloTipo = (roi, sep = ' – ') => roi.tipo ? `${roi.tipo}${sep}${GRUPOS_ROI[roi.tipo] || ''}` : '';

// Linha do item 7 do relatório de turno (única alteração no relatório)
function linhaItem7(roi) {
    const local = limpo(roi.local || roi.onde).replace(/[.;]+$/, '');
    return `Foi registrado o ROI Nº ${roi.numero} (${rotuloTipo(roi)})${local ? ' – ' + local : ''}${roi.simulado ? ' (SIMULADO)' : ''}.`;
}

// Linha do controle anual (mesmas colunas da planilha da equipe)
const CABECALHO_CONTROLE = ['Local', 'ROI Núm', 'Data Ocorrência', 'Tipo de Ocorrência', 'Responsável', 'Empresa', 'Descrição Ocorrência', 'Gestão', 'Data Comunicação', 'Destinatário'];
function linhaControle(roi) {
    return [
        roi.local || '', roi.numero || '', roi.data || '',
        `${rotuloTipo(roi, ' - ')}${roi.simulado ? ' - SIMULADO' : ''}`,
        roi.relator || '', roi.empresa || '', roi.descricao || roi.oque || roi.titulo || '',
        roi.gestao || '', roi.dataComunicacao || '', roi.destinatario || ''
    ];
}

// ------------------------- Locais -------------------------
const chaveLocal = l => semAcento(l).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function distancia(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
// Agrupa grafias do mesmo local ("Portaria Pincipal" = "Portaria Principal ") — nome do grupo = grafia mais usada
function agruparLocais(lista) {
    const cont = new Map();
    for (const l of lista) { const t = limpo(l).replace(/\s+/g, ' '); if (t) cont.set(t, (cont.get(t) || 0) + 1); }
    const grupos = [];
    for (const [nome, n] of [...cont].sort((a, b) => b[1] - a[1])) {
        const k = chaveLocal(nome);
        const nums = k.replace(/\D+/g, ' ').trim().split(' ').map(Number).filter(n => !isNaN(n)).join(',');   // "ADM 01" ≠ "ADM 02"
        const g = grupos.find(g => g.chaves.some(c => c === k || (k.length >= 8 && c.length >= 8 && distancia(c, k) <= 2
            && c.replace(/\D+/g, ' ').trim().split(' ').map(Number).filter(n => !isNaN(n)).join(',') === nums)));
        if (g) { g.total += n; g.variantes.push(nome); g.chaves.push(k); }
        else grupos.push({ nome, total: n, variantes: [nome], chaves: [k] });
    }
    return grupos.map(({ chaves, ...g }) => g).sort((a, b) => b.total - a.total);
}

// ------------------------- Estado -------------------------
async function carregar() {
    estado.rois = await store.get('rois', []) || [];
    estado.controle = { ...CONTROLE_INICIAL, ...(await store.get('rois_controle', {}) || {}) };
    estado.locais = await store.get('rois_locais', {}) || {};
    estado.carregado = true;
    marca++;
}
async function salvar() { marca++; await store.set('rois', estado.rois); }
const marcaRois = () => marca;

function roi(id) {
    const r = estado.rois.find(x => x.id === id);
    if (!r) throw erro('ROI não encontrado.', 404);
    return r;
}

function ultimoNumero(ano) {
    const doAno = estado.rois.filter(r => r.ano === ano && r.seq).map(r => r.seq);
    return Math.max(estado.controle[ano] || 0, ...doAno, 0);
}
function proximoNumero(ano = anoDaData(agora().data)) { return numeroRoi(ultimoNumero(ano) + 1, ano); }

// Campos editáveis do formulário (modelo da equipe)
const CAMPOS = ['tipo', 'titulo', 'relator', 'matricula', 'empresa', 'turno', 'area', 'local', 'oque', 'onde', 'quando', 'quem',
    'redacao', 'providencias', 'recomendacoes', 'data', 'hora', 'comunicante', 'funcao', 'site', 'responsavelArea', 'revisadoPor',
    'cienciaGestor', 'tempoAtendimento', 'bemDescricao', 'bemQuant', 'bemValorUnit', 'bemValorTotal', 'risco', 'roisAnteriores',
    'observacoes', 'anexos', 'gestao', 'dataComunicacao', 'destinatario'];
const AUTORIDADES = ['pm', 'pf', 'pc', 'outras'];

function limparDados(d = {}) {
    const o = {};
    for (const c of CAMPOS) if (d[c] !== undefined) o[c] = limpo(d[c]);
    if (o.data !== undefined) o.data = normalizarData(o.data);
    if (o.tipo !== undefined && !GRUPOS_ROI[o.tipo]) o.tipo = codigoDoTipo(o.tipo);
    if (o.risco !== undefined && !['Alto', 'Médio', 'Baixo', ''].includes(o.risco)) o.risco = '';
    if (d.simulado !== undefined) o.simulado = !!d.simulado;
    if (d.autoridades !== undefined) o.autoridades = Object.fromEntries(AUTORIDADES.map(k => [k, limpo(d.autoridades?.[k])]));
    if (d.envolvidos !== undefined) o.envolvidos = (Array.isArray(d.envolvidos) ? d.envolvidos : []).map(e => ({
        matricula: limpo(e.matricula), nome: limpo(e.nome), cargo: limpo(e.cargo), empresa: limpo(e.empresa), telefone: limpo(e.telefone)
    })).filter(e => e.nome || e.matricula || e.cargo).slice(0, 10);
    if (d.fotosLegendas && typeof d.fotosLegendas === 'object') o.fotosLegendas = d.fotosLegendas;
    return o;
}

function novoRoiBase(u) {
    const t = agora();
    const f = nucleo().estado.ficha || {};
    return {
        id: novoId(), status: 'rascunho', origem: 'app', numero: '', seq: 0, ano: 0, simulado: false,
        tipo: '', titulo: '', relator: u?.nome || '', matricula: '', empresa: '', turno: f.turno ? (f.turno === 'DIURNO' ? 'Diurno' : 'Noturno') : '',
        area: 'Segurança Patrimonial', local: '', oque: '', onde: '', quando: '', quem: '', redacao: '', providencias: '', recomendacoes: '',
        data: t.data, hora: t.hora, comunicante: '', funcao: '', site: 'Porto do Açu', responsavelArea: '', revisadoPor: '',
        cienciaGestor: '', tempoAtendimento: '', bemDescricao: '', bemQuant: '', bemValorUnit: '', bemValorTotal: '',
        envolvidos: [], risco: '', roisAnteriores: '', observacoes: '', autoridades: { pm: 'N/A', pf: 'N/A', pc: 'N/A', outras: 'N/A' }, anexos: '',
        gestao: '', dataComunicacao: '', destinatario: '', fotos: [], historico: [],
        criadoEm: t.iso, criadoPor: quem(u), atualizadoEm: t.iso
    };
}

async function criar(dados, u) {
    const r = Object.assign(novoRoiBase(u), limparDados(dados));
    if (dados.entradaId) {
        const item = nucleo().estado.entrada.find(e => e.id === dados.entradaId);
        if (item) {
            r.entradaId = item.id;
            r.redacao = r.redacao || limpo(item.texto);
            r.data = item.data || r.data; r.hora = item.hora || r.hora;
            r.comunicante = r.comunicante || item.autor || '';
            r.tipo = r.tipo || adivinharTipo(item.texto);
            r.simulado = r.simulado || ehSimulado(item.texto);
            item.destino = `ROI em rascunho`;
        }
    }
    delete r.fotosLegendas;
    estado.rois.push(r);
    await salvar();
    nucleo().auditar(u, 'ROI: rascunho criado', r.tipo || '');
    return r;
}

function registrarMudancas(r, novos, u, origem) {
    const campos = {};
    for (const [k, v] of Object.entries(novos)) {
        const ant = r[k];
        if (JSON.stringify(ant ?? '') !== JSON.stringify(v ?? '')) campos[k] = { de: ant ?? '', para: v ?? '' };
    }
    if (Object.keys(campos).length && r.status !== 'rascunho') {
        r.historico = r.historico || [];
        r.historico.push({ em: agora().iso, por: quem(u), origem, campos });
    }
    return Object.keys(campos).length;
}

async function editar(id, dados, u) {
    const r = roi(id);
    if (r.status === 'cancelado') throw erro('Este ROI foi cancelado.');
    const novos = limparDados(dados);
    const legendas = novos.fotosLegendas; delete novos.fotosLegendas;
    if (legendas) for (const f of r.fotos || []) if (legendas[f.id] !== undefined) f.legenda = limpo(legendas[f.id]).slice(0, 120);
    const mudou = registrarMudancas(r, novos, u, 'Correção');
    Object.assign(r, novos, { atualizadoEm: agora().iso });
    if (r.status === 'registrado' && mudou) await atualizarLinhaItem7(r);
    await salvar();
    if (mudou && r.status === 'registrado') nucleo().auditar(u, `ROI ${r.numero}: corrigido`, Object.keys(novos).join(', '));
    return r;
}

function validarParaRegistro(r) {
    const falta = [!r.tipo && 'tipo (G1 a G6)', !r.local && 'local', !r.data && 'data', !(r.redacao || r.oque) && 'o quê / redação da ocorrência', !r.relator && 'relator'].filter(Boolean);
    if (falta.length) throw erro('Para registrar, preencha: ' + falta.join(', ') + '.');
}

async function registrar(id, dados, u) {
    const r = roi(id);
    if (r.status !== 'rascunho') throw erro(`O ROI ${r.numero} já foi registrado.`);
    if (dados && Object.keys(dados).length) await editar(id, dados, u);
    validarParaRegistro(r);
    const ano = anoDaData(r.data);
    const seq = ultimoNumero(ano) + 1;
    Object.assign(r, { status: 'registrado', seq, ano, numero: numeroRoi(seq, ano), registradoEm: agora().iso, registradoPor: quem(u) });
    if (!r.titulo) r.titulo = (GRUPOS_ROI[r.tipo] || '').toUpperCase();
    // linha no item 7 do relatório do turno atual
    const linha = linhaItem7(r);
    const N = nucleo();
    await N.alterarFicha(f => { f.ocorrencias = f.ocorrencias || []; f.ocorrencias.push({ id: novoId(), texto: linha, roiId: r.id }); });
    r.fichaId = N.estado.ficha?.id || '';
    await salvar();
    N.auditar(u, `ROI ${r.numero} registrado`, `${rotuloTipo(r)} – ${r.local}${r.simulado ? ' (SIMULADO)' : ''}`);
    return r;
}

async function atualizarLinhaItem7(r) {
    const N = nucleo();
    if (!N.estado.ficha || N.estado.ficha.id !== r.fichaId) return;
    await N.alterarFicha(f => {
        const o = (f.ocorrencias || []).find(x => x.roiId === r.id);
        if (o) o.texto = linhaItem7(r);
    });
}

async function cancelar(id, motivo, u) {
    const r = roi(id);
    if (r.status === 'rascunho') {   // rascunho pode ser descartado (não tem número)
        estado.rois = estado.rois.filter(x => x.id !== id);
        for (const f of r.fotos || []) await store.set(`roi_foto_${f.id}`, null);
        await salvar();
        return { descartado: true };
    }
    if (r.origem === 'importado') throw erro('ROIs importados do controle anual não são cancelados aqui.');
    if (!limpo(motivo)) throw erro('Informe o motivo do cancelamento.');
    registrarMudancas(r, { status: 'cancelado' }, u, 'Cancelamento: ' + limpo(motivo));
    r.status = 'cancelado'; r.motivoCancelamento = limpo(motivo);
    const N = nucleo();
    if (N.estado.ficha?.id === r.fichaId) await N.alterarFicha(f => { f.ocorrencias = (f.ocorrencias || []).filter(x => x.roiId !== r.id); });
    await salvar();
    N.auditar(u, `ROI ${r.numero} cancelado`, limpo(motivo));
    return { roi: r };
}

// ------------------------- Fotos -------------------------
function dimensoesImagem(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20), tipo: 'png' };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let p = 2;
        while (p < buf.length - 9) {
            if (buf[p] !== 0xff) { p++; continue; }
            const m = buf[p + 1];
            if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { altura: buf.readUInt16BE(p + 5), largura: buf.readUInt16BE(p + 7), tipo: 'jpg' };
            p += 2 + buf.readUInt16BE(p + 2);
        }
        return { largura: 0, altura: 0, tipo: 'jpg' };
    }
    return null;
}

async function adicionarFoto(id, { base64, legenda }, u) {
    const r = roi(id);
    if (r.status === 'cancelado') throw erro('Este ROI foi cancelado.');
    r.fotos = r.fotos || [];
    if (r.fotos.length >= MAX_FOTOS) throw erro(`O modelo comporta até ${MAX_FOTOS} fotos.`);
    const dados = Buffer.from(String(base64 || '').replace(/^data:[^,]+,/, ''), 'base64');
    const dim = dimensoesImagem(dados);
    if (!dim) throw erro('Envie uma foto (JPG ou PNG).');
    if (dados.length > 900 * 1024) throw erro('Foto muito grande. Tente de novo (o app reduz a foto antes de enviar).');
    const foto = { id: novoId(), legenda: limpo(legenda).slice(0, 120), largura: dim.largura, altura: dim.altura, tipo: dim.tipo, em: agora().iso };
    await store.set(`roi_foto_${foto.id}`, { roiId: r.id, tipo: dim.tipo, base64: dados.toString('base64') });
    r.fotos.push(foto);
    if (r.status === 'registrado') registrarMudancas(r, { foto: 'adicionada' }, u, 'Foto incluída');
    await salvar();
    return foto;
}

async function removerFoto(id, fotoId, u) {
    const r = roi(id);
    const f = (r.fotos || []).find(x => x.id === fotoId);
    if (!f) throw erro('Foto não encontrada.', 404);
    r.fotos = r.fotos.filter(x => x.id !== fotoId);
    await store.set(`roi_foto_${fotoId}`, null);
    if (r.status === 'registrado') registrarMudancas(r, { foto: 'removida: ' + (f.legenda || fotoId) }, u, 'Foto removida');
    await salvar();
}

async function lerFoto(id, fotoId) {
    const r = roi(id);
    if (!(r.fotos || []).some(x => x.id === fotoId)) throw erro('Foto não encontrada.', 404);
    const d = await store.get(`roi_foto_${fotoId}`, null);
    if (!d) throw erro('Foto não encontrada.', 404);
    return { tipo: d.tipo === 'png' ? 'image/png' : 'image/jpeg', dados: Buffer.from(d.base64, 'base64') };
}

// ------------------------- Importação do controle anual -------------------------
function acharColunas(cab) {
    const n = cab.map(c => semAcento(c).toLowerCase().trim());
    const col = (...re) => n.findIndex(c => re.some(r => r.test(c)));
    return {
        local: col(/^local/), numero: col(/roi\s*num|^n.*roi|^roi$/), data: col(/data\s*ocorr/), tipo: col(/tipo/), responsavel: col(/respons/),
        empresa: col(/empresa/), descricao: col(/descri/), gestao: col(/gestao/), dataCom: col(/data\s*comunic/), destinatario: col(/destinat/)
    };
}

function lerControle(buffer) {
    const abas = lerXlsx(buffer);
    const rois = [], avisos = [];
    for (const aba of abas) {
        const iCab = aba.linhas.findIndex(l => (l || []).some(c => /roi\s*n[uú]m/i.test(String(c || ''))));
        if (iCab < 0) continue;
        const c = acharColunas(aba.linhas[iCab].map(x => String(x ?? '')));
        const anoAba = +((aba.nome.match(/\b(20\d{2})\b/) || [])[1] || 0);
        for (const [i, l] of aba.linhas.slice(iCab + 1).entries()) {
            const v = k => (c[k] >= 0 ? limpo(l[c[k]]) : '');
            const num = lerNumero(v('numero'));
            if (!num) { if (v('descricao') || v('local')) avisos.push(`${aba.nome}, linha ${iCab + i + 2}: sem número de ROI — ignorada.`); continue; }
            if (anoAba && num.ano !== anoAba) {
                avisos.push(`${aba.nome}: "${v('numero')}" está com o ano trocado — considerado ${numeroRoi(num.seq, anoAba)}.`);
                num.ano = anoAba;
            }
            const tipoOriginal = v('tipo');
            const tipo = codigoDoTipo(tipoOriginal, v('descricao'));
            const data = normalizarData(v('data'));
            rois.push({
                id: `imp_${num.ano}_${pad3(num.seq)}`, status: 'registrado', origem: 'importado', planilha: aba.nome,
                numero: numeroRoi(num.seq, num.ano), numeroOriginal: v('numero'), seq: num.seq, ano: num.ano,
                tipo, tipoOriginal, aClassificar: !/G\s*\.?\s*-?\s*[1-6]/i.test(tipoOriginal),
                simulado: ehSimulado(tipoOriginal, v('descricao')),
                local: v('local').replace(/\s+/g, ' '), data, relator: v('responsavel'), empresa: v('empresa'),
                descricao: v('descricao'), oque: v('descricao'), gestao: v('gestao'), dataComunicacao: normalizarData(v('dataCom')), destinatario: v('destinatario'),
                fotos: [], historico: []
            });
        }
    }
    return { rois, avisos };
}

async function importarControle(buffer, nomeArquivo, u) {
    let lido;
    try { lido = lerControle(buffer); } catch (e) { throw erro(`Não consegui ler "${nomeArquivo}": ${e.message}`); }
    if (!lido.rois.length) throw erro(`"${nomeArquivo}" não tem a coluna "ROI Núm" ou está vazia.`);
    const anos = [...new Set(lido.rois.map(r => r.ano))];
    const doApp = new Set(estado.rois.filter(r => r.origem !== 'importado').map(r => r.numero));
    const repetidos = [], conflitos = [];
    const vistos = new Set();
    const novos = [];
    for (const r of lido.rois) {
        if (vistos.has(r.numero)) { repetidos.push(r.numero); continue; }
        vistos.add(r.numero);
        if (doApp.has(r.numero)) { conflitos.push(r.numero); continue; }
        novos.push(r);
    }
    // reimportar a mesma planilha substitui as linhas que vieram dela antes (o que foi feito no app fica)
    const numeros = new Set(novos.map(r => r.numero));
    estado.rois = estado.rois.filter(r => !(r.origem === 'importado' && numeros.has(r.numero))).concat(novos);
    for (const a of anos) estado.controle[a] = Math.max(estado.controle[a] || 0, ...novos.filter(r => r.ano === a).map(r => r.seq));
    await store.set('rois_controle', estado.controle);
    await salvar();
    nucleo().auditar(u, 'ROI: controle anual importado', `${nomeArquivo}: ${novos.length} ROIs (${anos.join(', ')})`);
    return {
        arquivo: nomeArquivo, anos, importados: novos.length,
        porTipo: Object.fromEntries(Object.keys(GRUPOS_ROI).map(g => [g, novos.filter(r => r.tipo === g).length])),
        simulados: novos.filter(r => r.simulado).length,
        aClassificar: novos.filter(r => r.aClassificar).map(r => ({ numero: r.numero, tipoOriginal: r.tipoOriginal, tipo: r.tipo })),
        ultimo: anos.map(a => numeroRoi(ultimoNumero(a), a)),
        avisos: [...lido.avisos, ...repetidos.map(n => `${n} aparece mais de uma vez — mantida a primeira linha.`),
            ...conflitos.map(n => `${n} já existe no app — mantido o do app.`)]
    };
}

function resumoGeral() {
    const validos = estado.rois.filter(r => r.status === 'registrado');
    const anos = [...new Set(validos.map(r => r.ano))].sort();
    return {
        total: validos.length,
        porAno: anos.map(a => ({ ano: a, total: validos.filter(r => r.ano === a).length, ultimo: numeroRoi(ultimoNumero(a), a) })),
        locais: agruparLocais(validos.map(r => r.local)),
        proximo: proximoNumero()
    };
}

// ------------------------- Listagem -------------------------
function resumo(r) {
    return {
        id: r.id, numero: r.numero, status: r.status, origem: r.origem, tipo: r.tipo, grupo: GRUPOS_ROI[r.tipo] || '', simulado: !!r.simulado,
        titulo: r.titulo, local: r.local, data: r.data, hora: r.hora, relator: r.relator, ano: r.ano, seq: r.seq,
        descricao: r.descricao || r.oque || r.redacao || '', fotos: (r.fotos || []).length, aClassificar: !!r.aClassificar,
        atualizadoEm: r.atualizadoEm || r.registradoEm || ''
    };
}
function listar() {
    const ordem = r => (r.status === 'rascunho' ? 0 : 1);
    return estado.rois.slice().sort((a, b) => ordem(a) - ordem(b) || (b.ano - a.ano) || (b.seq - a.seq)
        || String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''))).map(resumo);
}
const locaisConhecidos = () => agruparLocais(estado.rois.map(r => r.local)).map(g => g.nome);

// ------------------------- Excel no modelo da equipe -------------------------
const PASTA_MODELO = path.join(__dirname, 'modelos', 'roi');
const escXml = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function preencherCelulas(xml, valores) {
    return xml.replace(/<c r="([A-Z]+\d+)"( s="\d+")?(?: t="\w+")?(\/>|>[\s\S]*?<\/c>)/g, (m, ref, s = '') => {
        if (!(ref in valores)) return m;
        const v = valores[ref];
        if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    });
}
function alturaLinha(xml, linha, ht, { mostrar = false } = {}) {
    return xml.replace(new RegExp(`<row r="${linha}"([^>]*?)(/?)>`), (m, attrs, fecha) => {
        let a = attrs.replace(/ ht="[^"]*"/, ` ht="${ht}"`).replace(/ customHeight="1"/, '') + ' customHeight="1"';
        if (!/ ht=/.test(a)) a = ` ht="${ht}"` + a;
        if (mostrar) a = a.replace(/ hidden="1"/, '');
        return `<row r="${linha}"${a}${fecha}>`;
    });
}
const linhasDeTexto = (t, porLinha) => String(t || '').split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(l.length / porLinha)), 0);

function planilhaAtual(r) {
    let xml = fs.readFileSync(path.join(PASTA_MODELO, 'sheet1.xml'), 'utf-8');
    const comRotulo = (rot, v) => `${rot}: ${limpo(v) || 'Não informado'}`;
    const v = {
        C4: r.numero || 'RASCUNHO', F4: r.relator, J4: r.matricula, L4: r.empresa, N4: r.turno,
        D5: `${r.titulo || (GRUPOS_ROI[r.tipo] || '').toUpperCase()}${r.simulado ? ' (SIMULADO)' : ''}`, L5: r.tipo, N5: r.area,
        F6: comRotulo('O quê', r.oque), F7: comRotulo('Onde', r.onde || r.local), F8: comRotulo('Quando', r.quando || [r.data, r.hora].filter(Boolean).join(', por volta das ')),
        F9: comRotulo('Quem', r.quem), F10: comRotulo('Redação da ocorrência', r.redacao), F11: comRotulo('Providências', r.providencias),
        F12: comRotulo('Recomendações', r.recomendacoes),
        F14: r.data, H14: r.hora, J14: r.comunicante, M14: r.funcao,
        F16: r.site, H16: r.local, J16: r.responsavelArea, L16: r.revisadoPor,
        F18: r.cienciaGestor, H18: r.tempoAtendimento, J18: r.bemDescricao, J20: r.bemQuant, K20: r.bemValorUnit, M20: r.bemValorTotal,
        H33: r.risco === 'Alto' ? 'x' : '', K33: r.risco === 'Médio' ? 'x' : '', N33: r.risco === 'Baixo' ? 'x' : '',
        F34: `ROI(s) anterior(es): ${limpo(r.roisAnteriores) || 'não informado(s)'}`, H34: r.observacoes,
        J36: r.autoridades?.pm || 'N/A', J37: r.autoridades?.pf || 'N/A', J38: r.autoridades?.pc || 'N/A', J39: r.autoridades?.outras || 'N/A',
        C40: [r.anexos, (r.fotos || []).length ? `Evidências fotográficas: ${(r.fotos || []).length} foto(s) — aba "Evidências Fotográficas".` : ''].filter(Boolean).join('\n')
    };
    (r.envolvidos || []).slice(0, 10).forEach((e, i) => {
        const l = 22 + i;
        Object.assign(v, { [`G${l}`]: e.matricula, [`H${l}`]: e.nome, [`J${l}`]: e.cargo, [`K${l}`]: e.empresa, [`M${l}`]: e.telefone });
    });
    xml = preencherCelulas(xml, v);
    // altura das linhas de texto livre (o modelo usa altura fixa)
    const MIN = { 6: 28, 7: 27, 8: 25, 9: 20.5, 10: 60, 11: 50.15, 12: 55 };
    for (let l = 6; l <= 12; l++) xml = alturaLinha(xml, l, Math.max(MIN[l], Math.round(linhasDeTexto(v['F' + l], 135) * 13.5 + 8)));
    xml = alturaLinha(xml, 18, Math.max(57, Math.round(linhasDeTexto(v.J18, 70) * 13.5 + 8)));
    xml = alturaLinha(xml, 34, Math.max(18, Math.round(linhasDeTexto(v.H34, 90) * 13.5 + 4)));
    xml = alturaLinha(xml, 40, Math.max(30, Math.round(linhasDeTexto(v.C40, 140) * 13.5 + 10)));
    for (let l = 29; l <= 31; l++) if ((r.envolvidos || []).length > l - 22) xml = alturaLinha(xml, l, 12.75, { mostrar: true });
    return xml.replace('{{DESENHO}}', '');
}

// Evidências fotográficas: 2 fotos por linha (colunas B e H), legendas nas linhas 6/27/48/69
const LINHAS_LEGENDA = [6, 27, 48, 69];
const EMU_COL = 733425;                  // largura de uma coluna (10,27) em EMU
const CAIXA = { largura: 4429125, altura: 3700000 };
function planilhaEvidencias(r, fotos) {
    let xml = fs.readFileSync(path.join(PASTA_MODELO, 'sheet2.xml'), 'utf-8');
    const v = {
        B2: `RELATÓRIO FOTOGRÁFICO  |  ${(r.titulo || GRUPOS_ROI[r.tipo] || 'OCORRÊNCIA').toUpperCase()}${r.simulado ? ' (SIMULADO)' : ''}`,
        B4: [r.local, r.data].filter(Boolean).join('  •  ') + (r.numero ? `  •  ROI Nº ${r.numero}` : ''),
        B90: fotos.length ? 'Imagens documentais da ocorrência.' : 'Sem evidências fotográficas anexadas.'
    };
    fotos.forEach((f, i) => { v[`${i % 2 ? 'H' : 'B'}${LINHAS_LEGENDA[Math.floor(i / 2)]}`] = `${String(i + 1).padStart(2, '0')} · ${f.legenda || 'Evidência'}`; });
    xml = preencherCelulas(xml, v);
    return xml.replace('{{DESENHO}}', fotos.length ? '<drawing r:id="rId1"/>' : '');
}
function desenhoFotos(fotos) {
    const ancoras = fotos.map((f, i) => {
        const esc = Math.min(CAIXA.largura / (f.largura || 4), CAIXA.altura / (f.altura || 3));
        const cx = Math.round((f.largura || 4) * esc), cy = Math.round((f.altura || 3) * esc);
        const sobra = Math.round((CAIXA.largura - cx) / 2);
        const col = (i % 2 ? 7 : 1) + Math.floor(sobra / EMU_COL), colOff = sobra % EMU_COL;
        const row = LINHAS_LEGENDA[Math.floor(i / 2)];   // linha seguinte à legenda (índice base 0)
        return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>85725</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Foto ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${ancoras}</xdr:wsDr>`;
}

function montarXlsxRoi(r, fotos = []) {
    const tem = fotos.length > 0;
    const rel = itens => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${itens}</Relationships>`;
    const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const arquivos = [
        { nome: '[Content_Types].xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${tem ? '<Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}</Types>` },
        { nome: '_rels/.rels', dados: rel(`<Relationship Id="rId1" Type="${T}officeDocument" Target="xl/workbook.xml"/>`) },
        { nome: 'xl/workbook.xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Atual" sheetId="1" r:id="rId1"/><sheet name="Evidências Fotográficas" sheetId="2" r:id="rId2"/></sheets></workbook>` },
        { nome: 'xl/_rels/workbook.xml.rels', dados: rel(`<Relationship Id="rId1" Type="${T}worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${T}worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${T}theme" Target="theme/theme1.xml"/><Relationship Id="rId4" Type="${T}styles" Target="styles.xml"/>`) },
        { nome: 'xl/styles.xml', dados: fs.readFileSync(path.join(PASTA_MODELO, 'styles.xml')) },
        { nome: 'xl/theme/theme1.xml', dados: fs.readFileSync(path.join(PASTA_MODELO, 'theme1.xml')) },
        { nome: 'xl/worksheets/sheet1.xml', dados: planilhaAtual(r) },
        { nome: 'xl/worksheets/sheet2.xml', dados: planilhaEvidencias(r, fotos) }
    ];
    if (tem) {
        arquivos.push(
            { nome: 'xl/worksheets/_rels/sheet2.xml.rels', dados: rel(`<Relationship Id="rId1" Type="${T}drawing" Target="../drawings/drawing2.xml"/>`) },
            { nome: 'xl/drawings/drawing2.xml', dados: desenhoFotos(fotos) },
            { nome: 'xl/drawings/_rels/drawing2.xml.rels', dados: rel(fotos.map((f, i) => `<Relationship Id="rId${i + 1}" Type="${T}image" Target="../media/foto${i + 1}.${f.tipo === 'png' ? 'png' : 'jpg'}"/>`).join('')) },
            ...fotos.map((f, i) => ({ nome: `xl/media/foto${i + 1}.${f.tipo === 'png' ? 'png' : 'jpg'}`, dados: f.dados }))
        );
    }
    return zip(arquivos);
}

function nomeArquivoRoi(r) {
    const base = `ROI - ${(r.numero || 'RASCUNHO').replace('/', '-')} - ${r.tipo || 'G'} - ${(GRUPOS_ROI[r.tipo] || '').toUpperCase()} - ${r.oque || r.titulo || ''}`;
    return semAcento(base).replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 120) + '.xlsx';
}

async function xlsxDoRoi(id) {
    const r = roi(id);
    const fotos = [];
    for (const f of r.fotos || []) {
        const d = await store.get(`roi_foto_${f.id}`, null);
        if (d) fotos.push({ ...f, tipo: d.tipo, dados: Buffer.from(d.base64, 'base64') });
    }
    return { nome: nomeArquivoRoi(r), dados: montarXlsxRoi(r, fotos) };
}

function xlsxControle(ano) {
    const doAno = estado.rois.filter(r => r.ano === ano && r.status !== 'rascunho').sort((a, b) => a.seq - b.seq);
    const linhas = [CABECALHO_CONTROLE, ...doAno.map(r => {
        const l = linhaControle(r);
        if (r.status === 'cancelado') l[6] = `CANCELADO — ${r.motivoCancelamento || ''}`;
        return l;
    })];
    return { nome: `Relatorio_de_Ocorrencias_Internas_${ano}.xlsx`, dados: gerarXlsx([{ nome: `ROI ${ano}`, cabecalho: true, larguras: [30, 11, 14, 30, 22, 20, 60, 16, 16, 20], linhas }]) };
}

// Controle de todos os anos: uma aba por ano (serve também para importar de novo)
function xlsxControleTodos() {
    const anos = [...new Set(estado.rois.filter(r => r.status !== 'rascunho' && r.ano).map(r => r.ano))].sort();
    const abas = anos.map(ano => {
        const doAno = estado.rois.filter(r => r.ano === ano && r.status !== 'rascunho').sort((a, b) => a.seq - b.seq);
        return { nome: `ROI ${ano}`, cabecalho: true, larguras: [30, 11, 14, 30, 22, 20, 60, 16, 16, 20], linhas: [CABECALHO_CONTROLE, ...doAno.map(r => {
            const l = linhaControle(r);
            if (r.status === 'cancelado') l[6] = `CANCELADO — ${r.motivoCancelamento || ''}`;
            return l;
        })] };
    });
    if (!abas.length) abas.push({ nome: 'ROI', cabecalho: true, linhas: [CABECALHO_CONTROLE] });
    return { nome: `Controle_ROI_${anos[0] || ''}${anos.length > 1 ? '-' + anos[anos.length - 1] : ''}.xlsx`, dados: gerarXlsx(abas) };
}

function detalhe(id) {
    const r = roi(id);
    return { ...r, grupo: GRUPOS_ROI[r.tipo] || '', linhaItem7: r.numero ? linhaItem7(r) : '', linhaControle: r.numero ? linhaControle(r) : [] };
}


// ------------------------- Indicador de ocorrências -------------------------
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const limparLocal = l => limpo(l).replace(/\s+/g, ' ');

// grafia → nome do local no indicador: grafias parecidas juntas, complemento junto do local principal
// ("Portaria Principal (Saída de veículos)" → "Portaria Principal") e, por cima, o que o admin confirmou.
function mapaDeLocais(rois = estado.rois) {
    const grupos = agruparLocais(rois.map(r => r.local));
    const ordem = grupos.slice().sort((a, b) => a.nome.length - b.nome.length);
    const destino = new Map(grupos.map(g => [g, g]));
    for (const g of grupos) {
        const k = chaveLocal(g.nome);
        const base = ordem.find(b => b !== g && chaveLocal(b.nome).length >= 6 && k.startsWith(chaveLocal(b.nome) + ' ')
            && /^\s*[(\-–,:]/.test(g.nome.slice(b.nome.length)));
        if (base) destino.set(g, destino.get(base));
    }
    const mapa = new Map();
    for (const g of grupos) for (const v of g.variantes) mapa.set(v, destino.get(g).nome);
    for (const [v, nome] of Object.entries(estado.locais || {})) if (nome) mapa.set(v, nome);
    return mapa;
}

function listaDeLocais() {
    const mapa = mapaDeLocais();
    const validos = estado.rois.filter(r => r.status === 'registrado');
    const porNome = new Map();
    for (const r of validos) {
        const v = limparLocal(r.local); if (!v) continue;
        const nome = mapa.get(v) || v;
        const g = porNome.get(nome) || { nome, total: 0, variantes: {} };
        g.total++; g.variantes[v] = (g.variantes[v] || 0) + 1;
        porNome.set(nome, g);
    }
    return [...porNome.values()].map(g => ({ ...g, variantes: Object.entries(g.variantes).map(([nome, total]) => ({ nome, total, confirmado: !!estado.locais[nome] })) }))
        .sort((a, b) => b.total - a.total);
}

// renomear um local do indicador (mesmo nome de outro = juntar). O texto do ROI não muda.
async function renomearLocal(variantes, nome, u) {
    for (const v of variantes || []) {
        const k = limparLocal(v); if (!k) continue;
        if (limpo(nome)) estado.locais[k] = limparLocal(nome); else delete estado.locais[k];
    }
    await store.set('rois_locais', estado.locais);
    marca++;
    nucleo().auditar(u, 'Indicador: local ajustado', `${(variantes || []).join(' | ')} → ${nome || '(automático)'}`);
    return listaDeLocais();
}

function mesAnoDe(r) {
    const m = String(r.data || '').match(/^\d{2}\/(\d{2})\/(\d{4})$/);
    return m ? { mes: +m[1], ano: +m[2] } : { mes: 0, ano: r.ano };
}
const contarTipos = lista => Object.fromEntries(Object.keys(GRUPOS_ROI).map(g => [g, lista.filter(r => r.tipo === g).length]).filter(([, n]) => n));
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const fmt1 = n => n.toFixed(1).replace('.', ',');

function indicadorOcorrencias({ ano, mes, tipos: filtroTipos, local: filtroLocal, empresa: filtroEmpresa } = {}) {
    const hoje = agora().data, [dHoje, mHoje, aHoje] = hoje.split('/').map(Number);
    const mapa = mapaDeLocais();
    const localDe = r => mapa.get(limparLocal(r.local)) || limparLocal(r.local) || '(sem local)';
    const registrados = estado.rois.filter(r => r.status === 'registrado');
    const mapaEmp = new Map();
    for (const g of agruparLocais(registrados.map(r => r.empresa))) for (const v of g.variantes) mapaEmp.set(v, g.nome);
    const empresaDe = r => mapaEmp.get(limparLocal(r.empresa)) || limparLocal(r.empresa) || '';
    const todos = registrados.map(r => ({ ...r, ...mesAnoDe(r), localNome: localDe(r), empresaNome: empresaDe(r) }));
    const anos = [...new Set([...todos.map(r => r.ano), aHoje])].sort((a, b) => b - a);
    ano = +ano || (anos.includes(aHoje) ? aHoje : anos[0] || aHoje);
    mes = +mes || 0;
    // filtros vindos do toque nos gráficos: tipo(s) e local
    filtroTipos = String(filtroTipos || '').split(',').filter(g => GRUPOS_ROI[g]);
    filtroLocal = limpo(filtroLocal);
    filtroEmpresa = limpo(filtroEmpresa);
    const porTipo = r => (!filtroTipos.length || filtroTipos.includes(r.tipo));
    const porEmpresa = r => !filtroEmpresa || r.empresaNome === filtroEmpresa;
    const semLocal = todos.filter(r => porTipo(r) && porEmpresa(r));                       // base dos locais (todos aparecem; o escolhido fica marcado)
    const validos = semLocal.filter(r => !filtroLocal || r.localNome === filtroLocal);
    const doAno = validos.filter(r => r.ano === ano);
    const escopo = mes ? doAno.filter(r => r.mes === mes) : doAno;
    const anoCorrente = ano === aHoje;

    // comparação com o mesmo período do ano anterior
    const limiteMes = mes || (anoCorrente ? mHoje : 12);
    const noPeriodo = r => (mes ? r.mes === mes : r.mes <= limiteMes) && (!anoCorrente || mes || r.mes < mHoje || (+String(r.data).slice(0, 2) <= dHoje));
    const anterior = validos.filter(r => r.ano === ano - 1 && noPeriodo(r)).length;

    // mês de referência × média dos 3 meses anteriores
    const refMes = mes || (anoCorrente ? mHoje : 12);
    const contaMes = (a, m) => validos.filter(r => r.ano === a && r.mes === m).length;
    const tres = [1, 2, 3].map(k => { const d = new Date(Date.UTC(ano, refMes - 1 - k, 1)); return contaMes(d.getUTCFullYear(), d.getUTCMonth() + 1); });
    const media = tres.reduce((a, b) => a + b, 0) / 3;
    const noMes = contaMes(ano, refMes);
    const parcial = anoCorrente && refMes === mHoje;

    const meses = Array.from({ length: anoCorrente ? mHoje : 12 }, (_, i) => {
        const lista = doAno.filter(r => r.mes === i + 1);
        return { mes: i + 1, nome: MESES[i].slice(0, 3), total: lista.length, porTipo: contarTipos(lista), simulados: lista.filter(r => r.simulado).length };
    });
    const tipos = contarTipos(escopo);
    const locaisMap = new Map();
    for (const r of semLocal.filter(r => r.ano === ano && (!mes || r.mes === mes))) { const n = r.localNome; const l = locaisMap.get(n) || []; l.push(r); locaisMap.set(n, l); }
    const locais = [...locaisMap].map(([nome, l]) => ({ nome, total: l.length, porTipo: contarTipos(l), simulados: l.filter(r => r.simulado).length }))
        .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome));
    const tiposTodos = contarTipos(todos.filter(r => r.ano === ano && (!mes || r.mes === mes) && (!filtroLocal || r.localNome === filtroLocal)));   // legenda: sem o filtro de tipo
    const porAno = anos.slice().sort().map(a => {
        const l = validos.filter(r => r.ano === a);
        return { ano: a, total: l.length, porTipo: contarTipos(l), simulados: l.filter(r => r.simulado).length, parcial: a === aHoje };
    });
    const simulados = escopo.filter(r => r.simulado);

    // perfil por tipo × mesmo período do ano anterior
    const tiposAnterior = contarTipos(validos.filter(r => r.ano === ano - 1 && noPeriodo(r)));

    // tendência: últimos 12 meses × 12 meses anteriores (até o mês de referência)
    const idx = r => r.ano * 12 + r.mes - 1, fim = ano * 12 + refMes - 1;
    const ultimos12 = validos.filter(r => idx(r) > fim - 12 && idx(r) <= fim).length;
    const anteriores12 = validos.filter(r => idx(r) > fim - 24 && idx(r) <= fim - 12).length;

    // empresas envolvidas (sem o filtro de empresa, para comparar)
    const empMap = new Map();
    for (const r of todos.filter(r => porTipo(r) && (!filtroLocal || r.localNome === filtroLocal) && r.ano === ano && (!mes || r.mes === mes) && r.empresaNome)) {
        const l = empMap.get(r.empresaNome) || []; l.push(r); empMap.set(r.empresaNome, l);
    }
    const empresas = [...empMap].map(([nome, l]) => ({ nome, total: l.length, porTipo: contarTipos(l) })).sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome));

    // reincidência: mesmo local + mesmo tipo repetido em até 90 dias (pelo menos uma ocorrência no período)
    const dia = r => { const m = String(r.data).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 864e5 : null; };
    const noEscopo = new Set(escopo.map(r => r.id));
    const chaves = new Map();
    for (const r of validos) { if (dia(r) === null || r.localNome === '(sem local)') continue; const k = `${r.localNome}|${r.tipo}`; const l = chaves.get(k) || []; l.push(r); chaves.set(k, l); }
    const reincidencias = [];
    for (const [k, l] of chaves) {
        l.sort((a, b) => dia(a) - dia(b));
        let grupo = [l[0]];
        const fechar = () => { if (grupo.length > 1 && grupo.some(r => noEscopo.has(r.id))) reincidencias.push({ local: k.split('|')[0], tipo: k.split('|')[1], total: grupo.length, rois: grupo.map(r => ({ id: r.id, numero: r.numero, data: r.data })) }); };
        for (const r of l.slice(1)) { if (dia(r) - dia(grupo[grupo.length - 1]) <= 90) grupo.push(r); else { fechar(); grupo = [r]; } }
        fechar();
    }
    reincidencias.sort((a, b) => b.total - a.total || b.rois[b.rois.length - 1].data.split('/').reverse().join('').localeCompare(a.rois[a.rois.length - 1].data.split('/').reverse().join('')));

    // análises em frases
    const frases = [];
    const total = escopo.length;
    const periodo = mes ? `de ${MESES[mes - 1].toLowerCase()}` : 'do ano';
    const topTipo = Object.entries(tipos).sort((a, b) => b[1] - a[1])[0];
    if (topTipo) frases.push(`${GRUPOS_ROI[topTipo[0]]} (${topTipo[0]}) responde por ${pct(topTipo[1], total)}% dos ROIs ${periodo} (${topTipo[1]} de ${total}).`);
    if (filtroLocal) {
        const l = locais.find(x => x.nome === filtroLocal), geral = l ? l.total : 0;
        const totGeral = semLocal.filter(r => r.ano === ano && (!mes || r.mes === mes)).length;
        if (totGeral) frases.push(`${filtroLocal} responde por ${geral} dos ${totGeral} ROIs ${periodo} (${pct(geral, totGeral)}%).`);
    } else if (locais[0] && total > 1) {
        const l = locais[0], unico = Object.keys(l.porTipo).length === 1 ? Object.keys(l.porTipo)[0] : '';
        frases.push(`${l.nome} concentra ${l.total} dos ${total} ROIs (${pct(l.total, total)}%)${unico && l.total > 1 ? `, todos de ${GRUPOS_ROI[unico].toLowerCase()}` : ''}.`);
    }
    const nomeRef = MESES[refMes - 1];
    if (!mes || mes === refMes) {
        const comp = noMes > media + 0.05 ? 'acima' : noMes < media - 0.05 ? 'abaixo' : 'igual';
        frases.push(`${nomeRef} ${parcial ? 'tem' : 'teve'} ${noMes} ROI${noMes === 1 ? '' : 's'}${parcial ? ' até agora' : ''}, ${comp === 'igual' ? 'igual à' : comp + ' da'} média dos últimos 3 meses (${fmt1(media)}).`);
    }
    if (!mes) {
        const pico = meses.slice().sort((a, b) => b.total - a.total)[0];
        if (pico && pico.total) frases.push(`${MESES[pico.mes - 1]} foi o mês com mais registros (${pico.total}).`);
    }
    const criticos = ['G1', 'G3'].filter(g => tipos[g] || tiposAnterior[g]);
    if (criticos.length) {
        const nomes = { G1: 'acidentes', G3: 'atos ilícitos' };
        const em = mes ? `em ${MESES[mes - 1].toLowerCase()}` : 'no ano';
        frases.push(`Tipos que mais preocupam ${em}: ${criticos.map(g => `${tipos[g] || 0} de ${nomes[g]} (${g})`).join(' e ')}; no mesmo período de ${ano - 1} foram ${criticos.map(g => tiposAnterior[g] || 0).join(' e ')}.`);
    }
    if (reincidencias.length) {
        const r0 = reincidencias[0];
        frases.push(`${reincidencias.length} ${reincidencias.length === 1 ? 'caso' : 'casos'} de reincidência (mesmo local e tipo em até 90 dias); o maior: ${r0.local}, ${r0.tipo}, ${r0.total} vezes.`);
    }
    if (!mes && (ultimos12 || anteriores12)) {
        const v = anteriores12 ? Math.round((ultimos12 - anteriores12) / anteriores12 * 100) : null;
        frases.push(`Nos últimos 12 meses foram ${ultimos12} ROIs${v === null ? '' : `, ${Math.abs(v)}% ${v < 0 ? 'a menos' : v > 0 ? 'a mais' : 'igual'} que nos 12 meses anteriores (${anteriores12})`}.`);
    }
    if (empresas[0] && !filtroEmpresa && total > 1) frases.push(`A empresa mais citada ${periodo} é ${empresas[0].nome} (${empresas[0].total} ROI${empresas[0].total === 1 ? '' : 's'}).`);
    if (simulados.length) frases.push(`${simulados.length} dos ${total} ROIs ${periodo} são simulados (contam no total).`);
    if (!total) frases.push(`Nenhum ROI registrado ${periodo}.`);

    return {
        ano, mes, anos, hoje, grupos: GRUPOS_ROI, filtroTipos, filtroLocal, filtroEmpresa, tiposTodos, tiposAnterior, empresas, reincidencias: reincidencias.slice(0, 30),
        tendencia: { ultimos12, anteriores12 }, total, anterior, anoAnterior: ano - 1, parcialAno: anoCorrente && !mes,
        mesRef: { mes: refMes, nome: nomeRef, total: noMes, media: Math.round(media * 10) / 10, parcial },
        tipos, simulados: simulados.length, meses, locais, porAno, frases,
        lista: escopo.sort((a, b) => b.ano - a.ano || b.seq - a.seq).slice(0, 200).map(r => ({ id: r.id, numero: r.numero, tipo: r.tipo, data: r.data, local: r.localNome, simulado: !!r.simulado, descricao: r.descricao || r.oque || '' }))
    };
}

module.exports = {
    indicadorOcorrencias, listaDeLocais, renomearLocal, mapaDeLocais,
    GRUPOS_ROI, MAX_FOTOS, estado, carregar, marcaRois, listar, detalhe, criar, editar, registrar, cancelar,
    adicionarFoto, removerFoto, lerFoto, importarControle, lerControle, resumoGeral, locaisConhecidos, proximoNumero,
    xlsxDoRoi, xlsxControle, xlsxControleTodos, montarXlsxRoi, linhaItem7, linhaControle, codigoDoTipo, adivinharTipo, agruparLocais, lerNumero, numeroRoi
};

// =====================================================================
// Permissões: o que cada perfil (e cada pessoa) pode ver e fazer
// O administrador ajusta em Menu › Permissões. Exceção por pessoa vale por cima do perfil.
// =====================================================================
const store = require('./store');

const CATALOGO = [
    { grupo: 'Plantão', chave: 'plantao.ver', rotulo: 'Ver o Plantão (turno, relatório, e-mails, histórico) e editar o relatório' },
    { grupo: 'Plantão', chave: 'plantao.liderar', rotulo: 'Assumir o plantão, herdar turno, publicar relatório e escala' },
    { grupo: 'Pendências', chave: 'pendencias.ver', rotulo: 'Ver e tratar pendências' },
    { grupo: 'ROI', chave: 'roi.registrar', rotulo: 'Abrir e registrar ROI' },
    { grupo: 'ROI', chave: 'roi.corrigir', rotulo: 'Corrigir ROI já registrado' },
    { grupo: 'Indicadores', chave: 'indicadores.ver', rotulo: 'Ver os indicadores de ocorrências' },
    { grupo: 'Indicadores', chave: 'mapa.ver', rotulo: 'Ver o mapa de calor' },
    { grupo: 'Indicadores', chave: 'mapa.marcar', rotulo: 'Marcar locais e empresas no mapa' },
    { grupo: 'Indicadores', chave: 'mapa.areas', rotulo: 'Ver e desenhar os contornos das áreas' },
    { grupo: 'Indicadores', chave: 'locais.padronizar', rotulo: 'Padronizar nomes dos locais' },
    { grupo: 'Equipe', chave: 'organograma.editar', rotulo: 'Lançar férias e substituições no organograma' }
];
const CHAVES = CATALOGO.map(c => c.chave);
const PERFIS_EDITAVEIS = ['LIDER', 'OPERADOR', 'SUNSET'];
const PADRAO = {
    LIDER: ['plantao.ver', 'plantao.liderar', 'pendencias.ver', 'roi.registrar', 'roi.corrigir', 'indicadores.ver', 'mapa.ver', 'mapa.marcar', 'organograma.editar'],
    OPERADOR: ['plantao.ver', 'pendencias.ver', 'roi.registrar', 'indicadores.ver'],
    SUNSET: ['roi.registrar']
};

let config = { perfis: {} };   // perfil → lista de chaves (quando o admin já ajustou)
async function carregar() { config = (await store.get('permissoes', null)) || { perfis: {} }; if (!config.perfis) config.perfis = {}; }

const doPerfil = perfil => perfil === 'ADMIN' ? CHAVES.slice() : (config.perfis[perfil] || PADRAO[perfil] || []).filter(k => CHAVES.includes(k));
function efetivas(u) {
    if (!u) return [];
    if (u.perfil === 'ADMIN') return CHAVES.slice();
    const s = new Set(doPerfil(u.perfil));
    for (const [k, v] of Object.entries(u.permissoes || {})) { if (!CHAVES.includes(k)) continue; if (v === true) s.add(k); else if (v === false) s.delete(k); }
    return [...s];
}
const pode = (u, chave) => !!u && (u.perfil === 'ADMIN' || efetivas(u).includes(chave));

function resumo() {
    return { catalogo: CATALOGO, perfisEditaveis: PERFIS_EDITAVEIS, perfis: Object.fromEntries(['ADMIN', ...PERFIS_EDITAVEIS].map(p => [p, doPerfil(p)])), padrao: PADRAO };
}
async function salvarPerfis(perfis) {
    const novo = {};
    for (const p of PERFIS_EDITAVEIS) if (Array.isArray(perfis?.[p])) novo[p] = [...new Set(perfis[p].filter(k => CHAVES.includes(k)))];
    config = { perfis: { ...config.perfis, ...novo } };
    await store.set('permissoes', config);
    return resumo();
}
// exceções de uma pessoa: { chave: true (libera) | false (bloqueia) }; o que não vier volta ao padrão do perfil
function limparExcecoes(exc) {
    const r = {};
    for (const [k, v] of Object.entries(exc || {})) if (CHAVES.includes(k) && (v === true || v === false)) r[k] = v;
    return r;
}

module.exports = { CATALOGO, CHAVES, PADRAO, carregar, efetivas, pode, resumo, salvarPerfis, limparExcecoes };

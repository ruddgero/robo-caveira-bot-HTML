// =====================================================================
// SERVIDOR WEB: entrega a tela e a API. Login por pessoa e permissões
// por perfil (Administrador, Líder, Operador). Só módulos nativos do Node.
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const nucleo = require('./nucleo');
const usuarios = require('./usuarios');
const whatsapp = require('./whatsapp');
const email = require('./email');
const store = require('./store');
const R = require('./relatorio');
const { agora } = require('./util');
const { gerarXlsx } = require('./xlsx');

// Arquivos da tela: SÓ estes podem ser entregues ao navegador
const PASTA_PUBLICA = __dirname;
const ARQUIVOS_PUBLICOS = new Set(['/index.html', '/app.js', '/style.css', '/manifest.json', '/sw.js', '/icon.svg', '/logo.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);
const COOKIE = 'cv_sessao';
const DURACAO_SESSAO_MS = 14 * 24 * 60 * 60 * 1000;
let SEGREDO = null;

const TIPOS = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'
};

// ------------------------- Sessão -------------------------------------
function assinar(dados) {
    const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
    return `${corpo}.${crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url')}`;
}

function usuarioDoToken(token) {
    if (!token || !token.includes('.')) return null;
    const [corpo, sig] = token.split('.');
    const esperado = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
    if (!sig || sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
    try {
        const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
        if (d.exp < Date.now()) return null;
        const u = usuarios.porId(d.uid);
        return u && u.ativo && u.versaoSenha === d.v ? u : null;
    } catch (_) { return null; }
}

function lerCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const ehHttps = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;

function definirCookie(req, res, u) {
    const token = assinar({ uid: u.id, v: u.versaoSenha, exp: Date.now() + DURACAO_SESSAO_MS });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${DURACAO_SESSAO_MS / 1000}${ehHttps(req) ? '; Secure' : ''}`);
}

const tentativas = new Map();
function bloqueado(chave) {
    const t = tentativas.get(chave);
    if (!t) return false;
    if (Date.now() - t.inicio > 10 * 60 * 1000) { tentativas.delete(chave); return false; }
    return t.n >= 6;
}
function falhou(chave) { const t = tentativas.get(chave) || { n: 0, inicio: Date.now() }; t.n++; tentativas.set(chave, t); }

// ------------------------- HTTP ---------------------------------------
function enviarJson(res, status, dados) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(dados));
}

function lerCorpo(req) {
    return new Promise((ok, falha) => {
        let tamanho = 0; const partes = [];
        req.on('data', c => {
            tamanho += c.length;
            if (tamanho > 2 * 1024 * 1024) { falha(Object.assign(new Error('Conteúdo muito grande.'), { status: 413 })); req.destroy(); return; }
            partes.push(c);
        });
        req.on('end', () => {
            if (!partes.length) return ok({});
            try { ok(JSON.parse(Buffer.concat(partes).toString('utf-8'))); }
            catch (_) { falha(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
        });
        req.on('error', falha);
    });
}

function servirArquivo(req, res, caminhoUrl) {
    let rel = decodeURIComponent(caminhoUrl.split('?')[0]);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const arquivo = path.join(PASTA_PUBLICA, path.basename(rel));
    if (!ARQUIVOS_PUBLICOS.has(rel) || !fs.existsSync(arquivo)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado');
    }
    const ext = path.extname(arquivo);
    res.writeHead(200, { 'Content-Type': TIPOS[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=120' });
    fs.createReadStream(arquivo).pipe(res);
}

async function qrComoSvg(texto) {
    if (!texto) return null;
    try { return await require('qrcode').toString(texto, { type: 'svg', margin: 1, width: 260 }); }
    catch (_) { return null; }
}

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const LIDERES = ['ADMIN', 'LIDER'];

// ------------------------- Rotas --------------------------------------
const rotas = [];
function rota(metodo, padrao, fn, opcoes = {}) {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn, ...opcoes });
}

function exigirPlantao(u) {
    if (nucleo.estado.plantao.liderId !== u.id) throw erro('Assuma o plantão para publicar (botão "Assumir plantão" na Central).', 409);
}

function marcas() {
    const e = nucleo.estado;
    return {
        ficha: e.versao,
        pendencias: `${e.pendencias.length}:${e.pendencias.reduce((s, p) => s + (p.historico?.length || 0), 0)}:${e.pendencias.filter(p => p.status === 'ABERTA').length}`,
        operacoes: `${e.operacoes.length}:${e.operacoes.filter(o => o.horaFinal).length}:${e.operacoes.filter(o => o.email?.enviadoEm || o.email?.erro).length}:${e.operacoes.reduce((s, o) => s + (o.historico?.length || 0) + (o.conferir?.length || 0) + (o.horaRetorno ? 1 : 0), 0)}`,
        relatorios: `${e.relatorios[0]?.id || ''}:${e.relatorios[0]?.herdadoEm || ''}:${e.plantao.relatorioPendenteId || ''}`,
        historico: e.historico.length,
        plantao: `${e.plantao.liderId || ''}:${e.plantao.sugerirNovaEscala ? 1 : 0}:${e.escala?.id || ''}`
    };
}

function resumoRelatorio(r) {
    if (!r) return null;
    const { texto, assinatura, ...resto } = r;
    return { ...resto, texto };
}

function operacaoParaTela(o) {
    return { ...o, rotuloTipo: R.TIPOS_OPERACAO[o.tipo]?.rotulo || o.tipo, mensagemPadrao: R.mensagemPadrao(o) };
}

function pendenciaParaTela(p) {
    const horas = (Date.now() - new Date(p.criadoEm).getTime()) / 3600000;
    return { ...p, turnosAberto: Math.max(1, Math.ceil(horas / 12)) };
}

rota('GET', '/ping', async () => ({ ok: true, hora: agora().hora }), { publica: true });

// --- Login
rota('POST', '/api/login', async (req, res, { corpo }) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const chave = `${ip}|${String(corpo.email || '').toLowerCase()}`;
    if (bloqueado(chave)) return [429, { erro: 'Muitas tentativas. Aguarde 10 minutos.' }];
    const u = usuarios.autenticar(corpo.email, corpo.senha);
    if (!u) { falhou(chave); return [401, { erro: 'E-mail ou senha incorretos.' }]; }
    tentativas.delete(chave);
    definirCookie(req, res, u);
    nucleo.auditar(u, 'Entrou no sistema');
    return { ok: true, usuario: usuarios.publico(u) };
}, { publica: true });

rota('POST', '/api/logout', async (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    return { ok: true };
}, { publica: true });

rota('GET', '/api/sessao', async req => ({ usuario: usuarios.publico(usuarioDoToken(lerCookies(req)[COOKIE])) }), { publica: true });

rota('POST', '/api/eu/senha', async (req, res, { corpo, u }) => {
    const atualizado = await usuarios.trocarSenha(u.id, corpo.atual, corpo.nova);
    definirCookie(req, res, atualizado);
    nucleo.auditar(u, 'Trocou a senha');
    return { ok: true, usuario: usuarios.publico(atualizado) };
}, { permiteTroca: true });

rota('PUT', '/api/eu', async (req, res, { corpo, u }) => ({ usuario: usuarios.publico(await usuarios.atualizar(u.id, { nome: corpo.nome, telefone: corpo.telefone })) }));

rota('GET', '/api/meta', async () => ({
    tipos: Object.fromEntries(Object.entries(R.TIPOS_OPERACAO).map(([k, v]) => [k, { rotulo: v.rotulo, autoridade: v.autoridade }])),
    movimentos: R.MOVIMENTOS, perfis: usuarios.ROTULO_PERFIL,
    email: { ativo: email.configurado(), motivo: email.motivoIndisponivel() },
    whatsappMax: whatsapp.MAX_ATIVAS, armazenamento: store.modo, versao: require('./package.json').version
}));

// --- Estado geral (consultado a cada poucos segundos)
rota('GET', '/api/estado', async (req, res, { u }) => {
    const e = nucleo.estado;
    const lider = nucleo.liderDePlantao();
    return {
        usuario: usuarios.publico(u),
        plantao: {
            liderId: e.plantao.liderId || null, liderNome: lider?.nome || null, assumidoEm: e.plantao.assumidoEm || null,
            sugerirNovaEscala: !!e.plantao.sugerirNovaEscala && !!lider, relatorioPendenteId: e.plantao.relatorioPendenteId || null
        },
        whatsapp: { meu: whatsapp.status(u.id), plantao: lider ? whatsapp.status(lider.id) : null },
        turno: { turno: e.ficha.turno, data: e.ficha.data },
        pendentesEntrada: e.entrada.filter(i => i.status === 'pendente').length,
        urgentes: e.entrada.filter(i => i.status === 'pendente' && i.urgente).length,
        pendenciasAbertas: e.pendencias.filter(p => p.status === 'ABERTA').length,
        marcas: marcas()
    };
});

// --- Central do Plantão
rota('GET', '/api/central', async () => {
    const e = nucleo.estado;
    const limite = Date.now() - 7 * 24 * 3600 * 1000;
    return {
        ficha: { id: e.ficha.id, turno: e.ficha.turno, data: e.ficha.data, herdadoDe: e.ficha.herdadoDe, publicadoEm: e.ficha.publicadoEm, vtr: e.ficha.vtr, atividades: e.ficha.atividades.length, ocorrencias: e.ficha.ocorrencias.length },
        conferencia: nucleo.conferencia(),
        pendencias: e.pendencias.filter(p => p.status === 'ABERTA' || new Date(p.concluidoEm || 0).getTime() > limite).map(pendenciaParaTela),
        operacoes: nucleo.operacoesDaFicha(e.ficha.id).map(operacaoParaTela),
        relatorios: e.relatorios.map(resumoRelatorio),
        relatorioPendente: resumoRelatorio(e.relatorios.find(r => r.id === e.plantao.relatorioPendenteId)),
        escala: e.escala ? { id: e.escala.id, dataInicio: e.escala.dataInicio, iniciadaPor: e.escala.iniciadaPor } : null,
        emailAtivo: email.configurado(),
        destinatario: nucleo.destinatarioEmail()
    };
});

rota('POST', '/api/plantao/assumir', async (req, res, { u }) => {
    const p = await nucleo.assumirPlantao(u);
    if (u.whatsapp?.pareado) whatsapp.ativar(u.id).catch(() => {});
    return { plantao: p };
}, { perfis: LIDERES });

rota('POST', '/api/plantao/manter-turno', async (req, res, { u }) => { await nucleo.dispensarRelatorioPendente(u); return { ok: true }; }, { perfis: LIDERES });

// --- Ficha do turno
rota('GET', '/api/ficha', async () => ({
    ficha: nucleo.estado.ficha, conferencia: nucleo.conferencia(),
    avisos: nucleo.avisosAbertos().map(pendenciaParaTela),
    operacoes: nucleo.operacoesDaFicha(nucleo.estado.ficha.id).map(operacaoParaTela)
}));

rota('PUT', '/api/ficha', async (req, res, { corpo }) => {
    try {
        const ficha = await nucleo.salvarFicha(corpo.ficha, corpo.versao);
        return { ficha, conferencia: nucleo.conferencia() };
    } catch (e) {
        if (e.status === 409) return [409, { erro: e.message, ficha: nucleo.estado.ficha }];
        throw e;
    }
});

rota('GET', '/api/ficha/texto', async () => ({
    whatsapp: nucleo.textoRelatorio(), simples: nucleo.textoRelatorio({ negrito: false }), conferencia: nucleo.conferencia()
}));

rota('POST', '/api/ficha/herdar', async (req, res, { corpo, u }) => ({ ficha: await nucleo.herdar(corpo.relatorioId, u) }), { perfis: LIDERES });
rota('POST', '/api/ficha/nova', async (req, res, { u }) => ({ ficha: await nucleo.novaFichaEmBranco(u) }), { perfis: LIDERES });

// Modo teste: tudo que seria publicado no grupo vai para o WhatsApp do próprio líder
function meuWhatsapp(u) {
    const st = whatsapp.status(u.id);
    return st?.numero ? `${st.numero}@s.whatsapp.net` : '';
}
function destinoPublicacao(u) {
    const cfg = nucleo.estado.config;
    if (cfg.modoTeste) {
        const jid = meuWhatsapp(u);
        if (!jid) throw erro('Modo teste ligado: conecte seu WhatsApp para receber a publicação no seu número.', 409);
        return { jid, teste: true };
    }
    if (!cfg.grupoPublicacao) throw erro('O administrador precisa escolher o grupo de publicação em Configurações.', 409);
    return { jid: cfg.grupoPublicacao, teste: false };
}

// Planilha de navios do turno: vai para o WhatsApp do líder (privado) e para o e-mail dele, se houver
async function entregarPlanilha(u, fichaId) {
    const pub = nucleo.planilhaDoTurno(fichaId);
    if (!pub) return false;
    const arq = nucleo.arquivoPlanilha(pub);
    const legenda = `🚢 Planilha de navios · ${pub.turno} ${pub.data}\nCopie as linhas e cole nas planilhas T-ORE / T-OIL do departamento.`;
    const jid = meuWhatsapp(u);
    if (jid) await whatsapp.enviarArquivo(u.id, jid, arq.dados, arq.nome, XLSX, legenda).catch(e => console.error('⚠️  [PLANILHA] WhatsApp:', e.message));
    if (u.email && email.configurado()) {
        await email.enviar({ para: u.email, assunto: `Planilha de navios - ${pub.turno} ${pub.data}`, corpo: legenda, anexos: [arq] })
            .catch(e => console.error('⚠️  [PLANILHA] E-mail:', e.message));
    }
    return true;
}

rota('POST', '/api/ficha/publicar', async (req, res, { corpo, u }) => {
    exigirPlantao(u);
    const destino = destinoPublicacao(u);
    const f = nucleo.estado.ficha;
    const fichaId = f.id;
    const texto = nucleo.textoRelatorio();
    await whatsapp.enviarTexto(u.id, destino.jid, destino.teste ? `🧪 *TESTE — não foi para o grupo*\n\n${texto}` : texto);
    if (corpo.anexarTxt) {
        await whatsapp.enviarDocumento(u.id, destino.jid, nucleo.textoRelatorio({ negrito: false }), `Relatorio_Turno_${f.turno}_${f.data.replace(/\//g, '-')}.txt`, '📄 Arquivo do relatório');
    }
    await nucleo.marcarPublicado(texto, u);
    const publicadoEm = nucleo.estado.ficha.publicadoEm;
    const passarOps = Array.isArray(corpo.passarOps) ? corpo.passarOps.map(String) : [];
    const nova = await nucleo.aposPublicar(texto, u, { passarOps });
    const planilha = await entregarPlanilha(u, fichaId).catch(() => false);
    return { ok: true, publicadoEm, teste: destino.teste, planilha, proximo: { turno: nova.ficha?.turno || nucleo.estado.ficha.turno, data: nucleo.estado.ficha.data } };
}, { perfis: LIDERES });

// --- Planilha de navios (T-ORE / T-OIL)
rota('GET', '/api/planilha-navios/previa', async () => {
    const arq = nucleo.arquivoPlanilha(nucleo.previaPlanilha());
    return { __arquivo: true, tipo: XLSX, nome: arq.nome.replace('.xlsx', '_PREVIA.xlsx'), dados: arq.dados };
});
rota('GET', '/api/planilha-navios/:turno/:data', async (req, res, { params }) => {
    const pub = nucleo.planilhaPorTurno(String(params.turno).toUpperCase(), String(params.data).replace(/-/g, '/'));
    if (!pub) throw erro('Este turno não tem planilha de navios (só os turnos publicados pelo robô a partir da versão 4.9).', 404);
    const arq = nucleo.arquivoPlanilha(pub);
    return { __arquivo: true, tipo: XLSX, nome: arq.nome, dados: arq.dados };
});

// --- Exportação em Excel
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const nomeArquivo = (pre, turno, data) => `${pre}_${turno || 'TURNO'}_${(data || '').replace(/\//g, '-')}.xlsx`;
function abaOperacoes(ops) {
    return {
        nome: 'Operações de bordo', cabecalho: true, larguras: [22, 24, 10, 22, 22, 22, 12, 10, 10, 18],
        linhas: [['Tipo', 'Navio', 'Terminal', 'Empresa', 'Motorista/Agente', 'Ajudante(s)', 'Placa', 'Entrada', 'Saída', 'E-mail'],
            ...ops.map(o => [R.TIPOS_OPERACAO[o.tipo]?.rotulo || o.tipo, o.navio, o.terminal, o.empresa, o.responsavel, o.ajudante, o.placa,
                o.horaInicial || '', o.horaFinal || 'sem saída', o.email?.encaminhadoEm ? 'Encaminhado' : o.email?.status === 'ENVIADO' ? 'Enviado ao líder' : 'Pendente'])]
    };
}
rota('GET', '/api/ficha/xlsx', async () => {
    const f = nucleo.estado.ficha;
    const abas = [{ nome: 'Relatório', larguras: [36, 100], linhas: R.linhasExcel(nucleo.textoRelatorio({ negrito: false })) }];
    const ops = nucleo.operacoesDaFicha(f.id);
    if (ops.length) abas.push(abaOperacoes(ops));
    return { __arquivo: true, tipo: XLSX, nome: nomeArquivo('Relatorio', f.turno, f.data), dados: gerarXlsx(abas) };
});

// --- Histórico completo de relatórios
const metaHist = h => ({ id: h.id, chave: h.chave, turno: h.turno, data: h.data, autor: h.autor, origem: h.origem, grupoNome: h.grupoNome, mensagemTs: h.mensagemTs });
rota('GET', '/api/relatorios-hist', async () => ({ relatorios: nucleo.historicoOrdenado().map(metaHist) }));
rota('GET', '/api/relatorios-hist/:id', async (req, res, { params }) => {
    const h = nucleo.estado.historico.find(x => x.id === params.id);
    if (!h) throw erro('Relatório não encontrado.', 404);
    let padrao = '';
    try { padrao = R.padronizarRelatorio(h.texto, { data: h.data, turno: h.turno }); } catch (_) { padrao = ''; }
    return { relatorio: { ...metaHist(h), texto: h.texto, padrao } };
});
rota('GET', '/api/relatorios-hist/:id/xlsx', async (req, res, { params }) => {
    const h = nucleo.estado.historico.find(x => x.id === params.id);
    if (!h) throw erro('Relatório não encontrado.', 404);
    let texto = h.texto;
    try { texto = R.padronizarRelatorio(h.texto, { data: h.data, turno: h.turno }); } catch (_) {}
    return { __arquivo: true, tipo: XLSX, nome: nomeArquivo('Relatorio', h.turno, h.data), dados: gerarXlsx([{ nome: 'Relatório', larguras: [36, 100], linhas: R.linhasExcel(texto) }]) };
});
rota('POST', '/api/relatorios-hist/:id/herdar', async (req, res, { params, u }) => ({ ficha: await nucleo.herdarDoHistorico(params.id, u) }), { perfis: LIDERES });
rota('POST', '/api/relatorios-hist/importar', async (req, res, { corpo, u }) => nucleo.importarMensagens(corpo.mensagens, u), { perfis: LIDERES });

// --- Equipes
rota('GET', '/api/equipes', async () => ({
    equipes: nucleo.estado.equipes,
    lideres: usuarios.todos().filter(x => x.ativo && usuarios.podeLiderar(x)).map(x => ({ id: x.id, nome: x.nome }))
}));
rota('POST', '/api/equipes', async (req, res, { corpo, u }) => ({ equipe: await nucleo.salvarEquipe(corpo, u) }), { perfis: LIDERES });
rota('POST', '/api/equipes/:id/excluir', async (req, res, { params, u }) => { await nucleo.excluirEquipe(params.id, u); return { ok: true }; }, { perfis: LIDERES });

// --- Nomes da equipe (botões da seção 8)
rota('GET', '/api/equipe', async () => ({ nomes: nucleo.nomesDaEquipe() }));
rota('POST', '/api/equipe', async (req, res, { corpo, u }) => ({ nomes: await nucleo.adicionarNomeEquipe(corpo.nome, u) }));
rota('POST', '/api/equipe/remover', async (req, res, { corpo, u }) => ({ nomes: await nucleo.removerNomeEquipe(corpo.nome, u) }), { perfis: LIDERES });

// --- Relatórios da equipe anterior
rota('GET', '/api/relatorios', async () => ({ relatorios: nucleo.estado.relatorios.map(resumoRelatorio) }));
rota('POST', '/api/relatorios', async (req, res, { corpo, u }) => {
    const texto = String(corpo.texto || '').trim();
    if (texto.length < 50) throw erro('Cole o texto completo do relatório.');
    return { relatorio: resumoRelatorio(await nucleo.registrarRelatorio({ texto, autor: 'Colado manualmente', manual: true }, u)) };
});

// --- Entrada
rota('GET', '/api/entrada', async () => ({ itens: nucleo.estado.entrada.slice().reverse() }));
rota('POST', '/api/entrada/:id', async (req, res, { corpo, params }) => ({ item: await nucleo.atualizarItemEntrada(params.id, corpo) }));

// --- Pendências
rota('GET', '/api/pendencias', async () => ({ pendencias: nucleo.estado.pendencias.map(pendenciaParaTela) }));
rota('POST', '/api/pendencias', async (req, res, { corpo, u }) => {
    const p = await nucleo.criarPendencia(corpo, u, corpo.entradaId ? 'Mensagem do grupo' : 'Registrada manualmente');
    if (corpo.entradaId) await nucleo.atualizarItemEntrada(corpo.entradaId, { status: 'usado', destino: p.tipo === 'DIGITAL' ? 'Pendência da Digital' : 'Aviso' }).catch(() => {});
    return { pendencia: pendenciaParaTela(p) };
});
rota('PUT', '/api/pendencias/:id', async (req, res, { corpo, params, u }) => ({ pendencia: pendenciaParaTela(await nucleo.editarPendencia(params.id, corpo, u)) }));
rota('POST', '/api/pendencias/:id/atualizar', async (req, res, { corpo, params, u }) => ({ pendencia: pendenciaParaTela(await nucleo.atualizarPendencia(params.id, corpo.texto, u)) }));
rota('POST', '/api/pendencias/:id/concluir', async (req, res, { corpo, params, u }) => ({ pendencia: pendenciaParaTela(await nucleo.concluirPendencia(params.id, corpo, u)) }));
rota('POST', '/api/pendencias/:id/reabrir', async (req, res, { params, u }) => ({ pendencia: pendenciaParaTela(await nucleo.reabrirPendencia(params.id, u)) }));
rota('POST', '/api/pendencias/:id/excluir', async (req, res, { params, u }) => { await nucleo.excluirPendencia(params.id, u); return { ok: true }; });

// --- Operações de bordo
rota('GET', '/api/operacoes', async () => ({ operacoes: nucleo.operacoesDaFicha(nucleo.estado.ficha.id).map(operacaoParaTela) }));
rota('POST', '/api/operacoes', async (req, res, { corpo, u }) => {
    const ops = await nucleo.registrarOperacoes(corpo.operacoes, { atividadeTexto: corpo.atividadeTexto || '', entradaId: corpo.entradaId || null, autor: corpo.autor || '', usuario: u });
    if (corpo.entradaId) await nucleo.atualizarItemEntrada(corpo.entradaId, { status: 'usado', destino: ops.length > 1 ? `${ops.length} operações de bordo` : 'Operação de bordo' }).catch(() => {});
    return { operacoes: ops.map(operacaoParaTela) };
});
// Minuta a partir dos dados do formulário (para copiar antes mesmo de registrar)
rota('POST', '/api/operacoes/minuta', async (req, res, { corpo }) => {
    const o = { ...(corpo || {}) };
    if (o.navio) o.navio = String(o.navio).split('\n')[0].trim().toUpperCase();
    return { ...R.minutaEmail(o), mensagem: R.mensagemPadrao(o) };
});
rota('PUT', '/api/operacoes/:id', async (req, res, { corpo, params, u }) => ({ operacao: operacaoParaTela(await nucleo.atualizarOperacao(params.id, corpo, u)) }));
rota('POST', '/api/operacoes/:id/saida', async (req, res, { corpo, params, u }) => {
    const o = await nucleo.registrarSaida(params.id, corpo.hora, u);
    if (corpo.entradaId) await nucleo.atualizarItemEntrada(corpo.entradaId, { status: 'usado', destino: 'Saída registrada' }).catch(() => {});
    return { operacao: operacaoParaTela(o) };
});
rota('POST', '/api/operacoes/:id/excluir', async (req, res, { params, u }) => { await nucleo.excluirOperacao(params.id, u); return { ok: true }; });
rota('GET', '/api/operacoes/:id/email', async (req, res, { params }) => {
    const o = nucleo.estado.operacoes.find(x => x.id === params.id);
    if (!o) throw erro('Operação não encontrada.', 404);
    const m = R.minutaEmail(o);
    return { ...m, para: nucleo.estado.config.emailDestinatarios || '', cc: nucleo.estado.config.emailCopia || '', lider: nucleo.destinatarioEmail(), status: o.email || {}, emailAtivo: email.configurado() };
});
rota('GET', '/api/emails/pendentes', async () => ({
    minutas: nucleo.minutasPendentes(), para: nucleo.estado.config.emailDestinatarios || '', cc: nucleo.estado.config.emailCopia || ''
}));
rota('POST', '/api/operacoes/:id/enviar-email', async (req, res, { params, u }) => {
    const o = nucleo.estado.operacoes.find(x => x.id === params.id);
    if (!o) throw erro('Operação não encontrada.', 404);
    const r = await nucleo.enviarEmailOperacao(o, { forcar: true, usuario: u });
    if (r.email?.status !== 'ENVIADO') throw erro(r.email?.erro || 'Não foi possível enviar.', 502);
    return { operacao: operacaoParaTela(r) };
});
rota('POST', '/api/operacoes/:id/marcar', async (req, res, { corpo, params, u }) => {
    if (!['encaminhadoEm', 'abertoEm'].includes(corpo.campo)) throw erro('Campo inválido.');
    return { operacao: operacaoParaTela(await nucleo.marcarEmailOperacao(params.id, corpo.campo, u)) };
});

// --- Escala
rota('GET', '/api/escala', async () => nucleo.construirPassagem());
rota('POST', '/api/escala/iniciar', async (req, res, { u }) => { await nucleo.iniciarEscala(u); return nucleo.construirPassagem(); }, { perfis: LIDERES });
rota('POST', '/api/escala/continuar', async (req, res, { u }) => { await nucleo.continuarEscala(u); return { ok: true }; }, { perfis: LIDERES });
rota('PUT', '/api/escala/passagem', async (req, res, { corpo, u }) => nucleo.salvarPassagem(corpo, u));
rota('POST', '/api/escala/restaurar', async (req, res, { u }) => nucleo.restaurarPassagem(u));
rota('GET', '/api/escala/texto', async () => ({ whatsapp: nucleo.textoPassagem(), simples: nucleo.textoPassagem({ negrito: false }) }));
rota('POST', '/api/escala/publicar', async (req, res, { corpo, u }) => {
    exigirPlantao(u);
    const cfg = nucleo.estado.config;
    const destino = destinoPublicacao(u);
    await whatsapp.enviarTexto(u.id, destino.jid, (destino.teste ? '🧪 *TESTE — não foi para o grupo*\n\n' : '') + nucleo.textoPassagem());
    if (corpo.anexarTxt) await whatsapp.enviarDocumento(u.id, destino.jid, nucleo.textoPassagem({ negrito: false }), `Passagem_Escala_${agora().data.replace(/\//g, '-')}.txt`, '📄 Passagem da escala');
    nucleo.auditar(u, 'Publicou a passagem da escala');
    return { ok: true };
}, { perfis: LIDERES });

// --- Histórico
rota('GET', '/api/historico', async () => ({
    itens: (await store.listarHistorico(40)).map(h => {
        const f = h.ficha;
        if (f.tipo === 'ESCALA') return { id: h.id, tipo: 'ESCALA', data: f.dataInicio, turno: 'Escala', texto: R.formatarPassagemEscala(f.dataInicio, f.passagem?.secoes || { digital: [], avisos: [], ocorrencias: [], atividades: [] }, { negrito: false }) };
        return { id: h.id, tipo: 'TURNO', data: f.data, turno: f.turno, publicadoEm: f.publicadoEm, texto: R.formatarRelatorio({ ...f, navios: f.navios && typeof f.navios.tore !== 'string' ? f.navios : { tore: [], toil: [] } }, f.avisos || [], { negrito: false }) };
    })
}));

// --- Configurações
rota('GET', '/api/config', async () => { const { ultimoTextoPublicado, ...cfg } = nucleo.estado.config; return { config: cfg }; });
rota('PUT', '/api/config', async (req, res, { corpo, u }) => { const { ultimoTextoPublicado, ...cfg } = await nucleo.salvarConfig(corpo.config || {}, u); return { config: cfg }; }, { perfis: ['ADMIN'] });
rota('GET', '/api/auditoria', async () => ({ itens: nucleo.estado.auditoria.slice().reverse().slice(0, 200) }), { perfis: ['ADMIN'] });

// --- Usuários (administrador)
rota('GET', '/api/usuarios', async () => ({
    usuarios: usuarios.todos().map(x => ({ ...usuarios.publico(x), whatsapp: { pareado: !!x.whatsapp?.pareado, numero: x.whatsapp?.numero || null, ...whatsapp.status(x.id), qr: undefined } }))
}), { perfis: ['ADMIN'] });
rota('POST', '/api/usuarios', async (req, res, { corpo, u }) => {
    const r = await usuarios.criar(corpo);
    nucleo.auditar(u, 'Cadastrou usuário', `${r.usuario.nome} (${r.usuario.perfil})`);
    return { usuario: usuarios.publico(r.usuario), senhaProvisoria: r.senhaProvisoria };
}, { perfis: ['ADMIN'] });
rota('PUT', '/api/usuarios/:id', async (req, res, { corpo, params, u }) => {
    const x = await usuarios.atualizar(params.id, corpo, { porAdmin: true });
    if (corpo.ativo === false) await whatsapp.desconectar(x.id).catch(() => {});
    nucleo.auditar(u, 'Alterou usuário', `${x.nome}`);
    return { usuario: usuarios.publico(x) };
}, { perfis: ['ADMIN'] });
rota('POST', '/api/usuarios/:id/senha', async (req, res, { params, u }) => {
    const senha = await usuarios.redefinirSenha(params.id);
    nucleo.auditar(u, 'Gerou senha provisória', usuarios.porId(params.id)?.nome);
    return { senhaProvisoria: senha };
}, { perfis: ['ADMIN'] });

// --- WhatsApp do próprio usuário (líderes)
rota('GET', '/api/whatsapp', async (req, res, { u }) => {
    const st = whatsapp.status(u.id);
    return {
        ...st, qr: undefined, qrSvg: await qrComoSvg(st.qr), disponivel: whatsapp.disponivel(), maxAtivas: whatsapp.MAX_ATIVAS,
        grupos: (u.whatsapp?.grupos || []).map(id => ({ id, nome: nucleo.estado.config.nomesGrupos?.[id] || whatsapp.nomesGrupos.get(id) || id })),
        pareado: !!u.whatsapp?.pareado, ehPlantao: nucleo.estado.plantao.liderId === u.id
    };
}, { perfis: LIDERES });
rota('POST', '/api/whatsapp/conectar', async (req, res, { u }) => ({ status: { ...(await whatsapp.ativar(u.id)), qr: undefined } }), { perfis: LIDERES });
rota('GET', '/api/whatsapp/grupos', async (req, res, { u }) => ({ grupos: await whatsapp.listarGrupos(u.id) }), { perfis: LIDERES });
rota('PUT', '/api/whatsapp/grupos', async (req, res, { corpo, u }) => {
    const ids = (corpo.grupos || []).map(String).filter(id => id.endsWith('@g.us'));
    await usuarios.atualizarWhatsapp(u.id, { grupos: ids });
    const nomes = { ...(nucleo.estado.config.nomesGrupos || {}), ...(corpo.nomes || {}) };
    await nucleo.salvarConfig({ nomesGrupos: nomes }, u);
    nucleo.auditar(u, 'Escolheu grupos do WhatsApp', ids.map(id => nomes[id] || id).join(', '));
    return { ok: true };
}, { perfis: LIDERES });
rota('POST', '/api/whatsapp/codigo', async (req, res, { corpo, u }) => ({ codigo: await whatsapp.pedirCodigo(u.id, corpo.numero) }), { perfis: LIDERES });
rota('POST', '/api/whatsapp/desconectar', async (req, res, { u }) => { await whatsapp.desconectar(u.id); nucleo.auditar(u, 'Desconectou o WhatsApp'); return { ok: true }; }, { perfis: LIDERES });
// Grupos para o administrador escolher o grupo de publicação
rota('GET', '/api/whatsapp/grupos-conhecidos', async () => ({
    grupos: Object.entries({ ...Object.fromEntries(whatsapp.nomesGrupos), ...(nucleo.estado.config.nomesGrupos || {}) }).map(([id, nome]) => ({ id, nome }))
}), { perfis: ['ADMIN'] });

// ------------------------- Servidor -----------------------------------
async function tratar(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");

    const url = req.url.split('?')[0];
    const r = rotas.find(x => x.metodo === req.method && x.re.test(url));
    if (!r) {
        if (url.startsWith('/api/')) return enviarJson(res, 404, { erro: 'Rota não encontrada.' });
        if (req.method !== 'GET') return enviarJson(res, 405, { erro: 'Método não permitido.' });
        return servirArquivo(req, res, req.url);
    }
    try {
        let u = null;
        if (!r.publica) {
            u = usuarioDoToken(lerCookies(req)[COOKIE]);
            if (!u) return enviarJson(res, 401, { erro: 'Faça login novamente.' });
            if (u.trocarSenha && !r.permiteTroca) return enviarJson(res, 403, { erro: 'Troque sua senha provisória para continuar.', trocarSenha: true });
            if (r.perfis && !r.perfis.includes(u.perfil)) return enviarJson(res, 403, { erro: 'Seu perfil não tem permissão para esta ação.' });
        }
        if (req.method !== 'GET' && req.headers['x-caveira'] !== '1') return enviarJson(res, 403, { erro: 'Requisição recusada.' });
        const m = url.match(r.re);
        const params = Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const corpo = req.method === 'GET' ? {} : await lerCorpo(req);
        const saida = await r.fn(req, res, { corpo, params, u });
        if (Array.isArray(saida)) return enviarJson(res, saida[0], saida[1]);
        if (saida && saida.__arquivo) {
            res.writeHead(200, {
                'Content-Type': saida.tipo, 'Content-Length': saida.dados.length, 'Cache-Control': 'no-store',
                'Content-Disposition': `attachment; filename="${saida.nome.replace(/[^\w.\-]/g, '_')}"`
            });
            return res.end(saida.dados);
        }
        return enviarJson(res, 200, saida);
    } catch (e) {
        const st = e.status || 500;
        if (st >= 500) console.error(`❌ [API] ${req.method} ${url}:`, e);
        return enviarJson(res, st, { erro: st >= 500 && st !== 502 && st !== 503 ? 'Erro interno: ' + e.message : e.message });
    }
}

async function iniciar(porta) {
    SEGREDO = process.env.SESSAO_SEGREDO || await store.get('segredo_sessao', null);
    if (!SEGREDO) {
        SEGREDO = crypto.randomBytes(32).toString('hex');
        await store.set('segredo_sessao', SEGREDO);
    }
    return new Promise(ok => {
        const srv = http.createServer((req, res) => { tratar(req, res); });
        srv.listen(porta, () => { console.log(`🌐 [PAINEL] Aberto em http://localhost:${porta}`); ok(srv); });
    });
}

module.exports = { iniciar };

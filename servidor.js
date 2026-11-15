// =====================================================================
// SERVIDOR WEB: entrega a tela (pasta public) e a API, tudo protegido
// por senha. Usa só o módulo http do Node (sem dependências extras).
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const nucleo = require('./nucleo');
const whatsapp = require('./whatsapp');
const store = require('./store');
const R = require('./relatorio');
const { agora } = require('./util');

const PASTA_PUBLICA = path.join(__dirname, '..', 'public');
const COOKIE = 'cv_sessao';
const DURACAO_SESSAO_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias
let SEGREDO = null;

const TIPOS = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

// ------------------------- Sessão / login -----------------------------
function assinar(dados) {
    const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
    const sig = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
    return `${corpo}.${sig}`;
}

function validar(token) {
    if (!token || !token.includes('.')) return null;
    const [corpo, sig] = token.split('.');
    const esperado = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
    if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
    try {
        const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
        return d.exp > Date.now() ? d : null;
    } catch (_) { return null; }
}

function lerCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function ehHttps(req) {
    return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}

const tentativasLogin = new Map();
function bloqueadoPorTentativas(ip) {
    const t = tentativasLogin.get(ip);
    if (!t) return false;
    if (Date.now() - t.inicio > 10 * 60 * 1000) { tentativasLogin.delete(ip); return false; }
    return t.n >= 6;
}
function registrarFalha(ip) {
    const t = tentativasLogin.get(ip) || { n: 0, inicio: Date.now() };
    t.n += 1; tentativasLogin.set(ip, t);
}

function senhaConfere(digitada) {
    const a = crypto.createHash('sha256').update(String(digitada || '')).digest();
    const b = crypto.createHash('sha256').update(String(process.env.APP_SENHA || '')).digest();
    return crypto.timingSafeEqual(a, b);
}

// ------------------------- Utilidades HTTP ----------------------------
function enviarJson(res, status, dados) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(dados));
}

function lerCorpo(req) {
    return new Promise((ok, falha) => {
        let tamanho = 0; const partes = [];
        req.on('data', c => {
            tamanho += c.length;
            if (tamanho > 1024 * 1024) { falha(Object.assign(new Error('Conteúdo muito grande.'), { status: 413 })); req.destroy(); return; }
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
    const arquivo = path.normalize(path.join(PASTA_PUBLICA, rel));
    if (!arquivo.startsWith(PASTA_PUBLICA) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado');
    }
    const ext = path.extname(arquivo);
    res.writeHead(200, {
        'Content-Type': TIPOS[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(arquivo).pipe(res);
}

async function qrComoSvg(texto) {
    if (!texto) return null;
    try { return await require('qrcode').toString(texto, { type: 'svg', margin: 1, width: 260 }); }
    catch (_) { return null; }
}

// ------------------------- Rotas da API -------------------------------
const rotas = [];
const rota = (metodo, padrao, fn, publica = false) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn, publica });
};

rota('GET', '/ping', async () => ({ ok: true, whatsapp: whatsapp.status.estado, hora: agora().hora }), true);

rota('POST', '/api/login', async (req, res, { corpo }) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (bloqueadoPorTentativas(ip)) return [429, { erro: 'Muitas tentativas. Aguarde 10 minutos.' }];
    if (!senhaConfere(corpo.senha)) { registrarFalha(ip); return [401, { erro: 'Senha incorreta.' }]; }
    tentativasLogin.delete(ip);
    const token = assinar({ exp: Date.now() + DURACAO_SESSAO_MS });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${DURACAO_SESSAO_MS / 1000}${ehHttps(req) ? '; Secure' : ''}`);
    return { ok: true };
}, true);

rota('POST', '/api/logout', async (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    return { ok: true };
}, true);

rota('GET', '/api/sessao', async (req) => ({ logado: !!validar(lerCookies(req)[COOKIE]) }), true);

rota('GET', '/api/estado', async () => {
    const e = nucleo.estado;
    return {
        whatsapp: { estado: whatsapp.status.estado, numero: whatsapp.status.numero, erro: whatsapp.status.erro },
        pendentes: e.entrada.filter(i => i.status === 'pendente').length,
        urgentes: e.entrada.filter(i => i.status === 'pendente' && i.urgente).length,
        relatorioUS: e.relatorioUS ? { capturadoEm: e.relatorioUS.capturadoEm, herdadoEm: e.relatorioUS.herdadoEm } : null,
        fichaVersao: e.versao,
        configurado: e.config.gruposMonitorados.length > 0,
        armazenamento: store.modo
    };
});

// Ficha do turno
rota('GET', '/api/ficha', async () => ({ ficha: nucleo.estado.ficha, conferencia: R.conferirFicha(nucleo.estado.ficha) }));
rota('PUT', '/api/ficha', async (req, res, { corpo }) => {
    const ficha = await nucleo.salvarFicha(corpo.ficha, corpo.versao);
    return { ficha, conferencia: R.conferirFicha(ficha) };
});
rota('GET', '/api/ficha/texto', async () => ({
    whatsapp: R.formatarRelatorio(nucleo.estado.ficha),
    simples: R.formatarRelatorio(nucleo.estado.ficha, { negrito: false }),
    conferencia: R.conferirFicha(nucleo.estado.ficha)
}));
rota('POST', '/api/ficha/herdar', async () => ({ ficha: await nucleo.herdar() }));
rota('POST', '/api/ficha/nova', async () => ({ ficha: await nucleo.novaFichaEmBranco() }));
rota('POST', '/api/ficha/publicar', async (req, res, { corpo }) => {
    const cfg = nucleo.estado.config;
    if (!cfg.grupoPublicacao) return [409, { erro: 'Escolha o grupo de publicação em Configurações.' }];
    const f = nucleo.estado.ficha;
    const texto = R.formatarRelatorio(f);
    await whatsapp.enviarTexto(cfg.grupoPublicacao, texto);
    if (corpo.anexarTxt) {
        const nome = `Relatorio_Turno_${f.turno}_${f.data.replace(/\//g, '-')}.txt`;
        await whatsapp.enviarDocumento(cfg.grupoPublicacao, R.formatarRelatorio(f, { negrito: false }), nome, '📄 Arquivo do relatório');
    }
    await nucleo.marcarPublicado(texto);
    return { ok: true, publicadoEm: nucleo.estado.ficha.publicadoEm };
});

// Relatório da US
rota('GET', '/api/relatorio-us', async () => ({ relatorio: nucleo.estado.relatorioUS }));
rota('POST', '/api/relatorio-us', async (req, res, { corpo }) => {
    const texto = String(corpo.texto || '').trim();
    if (texto.length < 50) return [400, { erro: 'Cole o texto completo do relatório.' }];
    return { relatorio: await nucleo.registrarRelatorioUS({ texto, autor: corpo.autor || 'Colado manualmente', manual: true }) };
});

// Caixa de entrada
rota('GET', '/api/entrada', async () => ({ itens: nucleo.estado.entrada.slice().reverse() }));
rota('POST', '/api/entrada/:id', async (req, res, { corpo, params }) => ({ item: await nucleo.atualizarItemEntrada(params.id, corpo) }));

// E-mail de operação de bordo
rota('GET', '/api/email/:opId', async (req, res, { params }) => {
    const op = (nucleo.estado.ficha.operacoes || []).find(o => o.id === params.opId);
    if (!op) return [404, { erro: 'Operação não encontrada.' }];
    return R.minutaEmail(op, nucleo.estado.ficha, nucleo.estado.config);
});

// Histórico
rota('GET', '/api/historico', async () => ({
    itens: (await store.listarHistorico(30)).map(h => ({ id: h.id, data: h.ficha.data, turno: h.ficha.turno, publicadoEm: h.ficha.publicadoEm, texto: R.formatarRelatorio(h.ficha, { negrito: false }) }))
}));

// Configurações
rota('GET', '/api/config', async () => {
    const { ultimoTextoPublicado, ...cfg } = nucleo.estado.config;
    return { config: cfg };
});
rota('PUT', '/api/config', async (req, res, { corpo }) => {
    const { ultimoTextoPublicado, ...cfg } = await nucleo.salvarConfig(corpo.config || {});
    return { config: cfg };
});

// WhatsApp
rota('GET', '/api/whatsapp', async () => ({ ...whatsapp.status, qr: undefined, qrSvg: await qrComoSvg(whatsapp.status.qr) }));
rota('GET', '/api/whatsapp/grupos', async () => ({ grupos: await whatsapp.listarGrupos() }));
rota('POST', '/api/whatsapp/codigo', async (req, res, { corpo }) => ({ codigo: await whatsapp.pedirCodigo(corpo.numero) }));
rota('POST', '/api/whatsapp/desconectar', async () => { await whatsapp.desconectar(); return { ok: true }; });

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
        if (!r.publica && !validar(lerCookies(req)[COOKIE])) return enviarJson(res, 401, { erro: 'Faça login novamente.' });
        if (req.method !== 'GET' && req.headers['x-caveira'] !== '1') return enviarJson(res, 403, { erro: 'Requisição recusada.' });
        const m = url.match(r.re);
        const params = Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const corpo = req.method === 'GET' ? {} : await lerCorpo(req);
        const saida = await r.fn(req, res, { corpo, params });
        if (Array.isArray(saida)) return enviarJson(res, saida[0], saida[1]);
        return enviarJson(res, 200, saida);
    } catch (e) {
        const st = e.status || 500;
        if (st >= 500) console.error(`❌ [API] ${req.method} ${url}:`, e);
        return enviarJson(res, st, { erro: st >= 500 ? 'Erro interno: ' + e.message : e.message });
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

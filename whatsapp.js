// =====================================================================
// WHATSAPP POR LÍDER (Baileys / aparelho conectado)
// - Cada líder conecta o próprio número
// - Ficam ativos: o líder de plantão + 1 reserva (cabe no plano grátis);
//   os demais ficam com a sessão GUARDADA e pausada
// - Lê só os grupos que cada líder marcou; nunca responde nos grupos
// - Publica pelo número do líder de plantão
// =====================================================================
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_ATIVAS = Math.max(1, parseInt(process.env.WHATSAPP_MAX_SESSOES || '2', 10));
const TEMPO_PAREAMENTO_MS = 6 * 60 * 1000;

let baileys = null;
let logger = null;
const sessoes = new Map();
const nomesGrupos = new Map();
let h = {
    mensagem: async () => {},
    gruposDe: () => [],          // (uid) -> ids de grupos que esse usuário liberou
    nomeSessao: uid => `whatsapp_sessao_${uid}`,
    liderPlantao: () => null,    // uid do líder de plantão
    pareado: () => {},           // (uid, numero|null)
};

function sessao(uid) {
    if (!sessoes.has(uid)) {
        sessoes.set(uid, { uid, estado: 'PAUSADO', qr: null, numero: null, erro: null, sock: null, auth: null, tentativas: 0, timer: null, ativadoEm: 0, pausada: true, aguardandoDesde: 0 });
    }
    return sessoes.get(uid);
}

function definir(s, estado, extra = {}) { Object.assign(s, { estado, desde: new Date().toISOString() }, extra); }

async function abrirAuth(uid) {
    const nome = h.nomeSessao(uid);
    if (store.db) {
        const usarSessaoFirestore = require('./sessaoFirestore');
        return usarSessaoFirestore(store.db, baileys, nome);
    }
    const pasta = path.join(store.PASTA_DADOS, nome);
    const { state, saveCreds } = await baileys.useMultiFileAuthState(pasta);
    return { state, saveCreds, limpar: async () => fs.rmSync(pasta, { recursive: true, force: true }) };
}

function textoDaMensagem(message) {
    if (!message) return '';
    const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message;
    if (m.protocolMessage?.editedMessage) return textoDaMensagem(m.protocolMessage.editedMessage);
    if (m.editedMessage?.message) return textoDaMensagem(m.editedMessage.message);
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
        m.videoMessage?.caption || m.documentMessage?.caption || m.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
}

function idEditado(message) {
    const m = message?.ephemeralMessage?.message || message;
    return m?.protocolMessage?.editedMessage ? m.protocolMessage.key?.id : (m?.editedMessage ? m.editedMessage.message?.protocolMessage?.key?.id : null);
}

// Mensagem apagada "para todos": protocolMessage do tipo REVOKE (0) aponta o id da mensagem apagada
function idApagado(message) {
    const m = message?.ephemeralMessage?.message || message;
    const p = m?.protocolMessage;
    return p && (p.type === 0 || p.type === 'REVOKE') && p.key?.id ? p.key.id : null;
}

function timestampMs(t) {
    if (!t) return Date.now();
    const n = typeof t === 'object' ? (t.toNumber ? t.toNumber() : Number(t.low)) : Number(t);
    return n * 1000;
}

async function nomeDoGrupo(s, jid) {
    if (nomesGrupos.has(jid)) return nomesGrupos.get(jid);
    try { const meta = await s.sock.groupMetadata(jid); nomesGrupos.set(jid, meta.subject); return meta.subject; }
    catch (_) { return ''; }
}

async function processar(s, m, historico) {
    try {
        const chatId = m.key?.remoteJid || '';
        if (!chatId.endsWith('@g.us') || !m.message) return;
        if (!h.gruposDe(s.uid).includes(chatId)) return;
        const apagaId = idApagado(m.message);
        if (apagaId) return await h.mensagem({ apagaId, chatId, timestamp: timestampMs(m.messageTimestamp), historico, viaUid: s.uid });
        const texto = textoDaMensagem(m.message);
        if (!texto) return;
        const participante = m.key.participant || m.participant || '';
        await h.mensagem({
            id: m.key.id,
            editaId: idEditado(m.message) || null,
            chatId,
            grupoNome: await nomeDoGrupo(s, chatId),
            autor: m.pushName || participante.split('@')[0],
            remetenteNumero: participante.endsWith('@s.whatsapp.net') ? participante.split('@')[0] : '',
            texto,
            timestamp: timestampMs(m.messageTimestamp),
            fromMe: !!m.key.fromMe,
            historico,
            viaUid: s.uid
        });
    } catch (e) {
        console.error('⚠️  [WHATSAPP] Erro ao processar mensagem:', e.message);
    }
}

async function conectar(s) {
    clearTimeout(s.timer);
    s.pausada = false;
    definir(s, 'CONECTANDO', { qr: null, erro: null });
    s.auth = await abrirAuth(s.uid);
    const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = baileys.default({
        version,
        logger,
        auth: { creds: s.auth.state.creds, keys: baileys.makeCacheableSignalKeyStore(s.auth.state.keys, logger) },
        browser: baileys.Browsers ? baileys.Browsers.macOS('Chrome') : ['Caveira Bot', 'Chrome', '120.0.0'],
        markOnlineOnConnect: false,          // não "rouba" as notificações do celular do líder
        syncFullHistory: false,
        shouldIgnoreJid: jid => !jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
        getMessage: async () => undefined
    });
    s.sock = sock;
    const atual = () => s.sock === sock && !s.pausada;

    sock.ev.on('creds.update', () => s.auth.saveCreds().catch(e => console.error('Erro ao salvar sessão:', e.message)));

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (!atual()) return;
        if (qr) {
            if (!s.aguardandoDesde) s.aguardandoDesde = Date.now();
            if (Date.now() - s.aguardandoDesde > TEMPO_PAREAMENTO_MS) {
                await pausar(s.uid, 'Tempo para conectar esgotado. Toque em "Conectar" de novo.');
                return;
            }
            definir(s, 'AGUARDANDO_PAREAMENTO', { qr });
        }
        if (connection === 'open') {
            s.tentativas = 0; s.aguardandoDesde = 0;
            const numero = (sock.user?.id || '').split(':')[0].split('@')[0];
            definir(s, 'CONECTADO', { qr: null, numero, erro: null });
            h.pareado(s.uid, numero);
            console.log(`💀 [WHATSAPP] ${s.uid} conectado (+${numero}).`);
            try { Object.values(await sock.groupFetchAllParticipating()).forEach(g => nomesGrupos.set(g.id, g.subject)); } catch (_) {}
        }
        if (connection === 'close') {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            if (codigo === baileys.DisconnectReason.loggedOut) {
                console.log(`🔌 [WHATSAPP] ${s.uid}: aparelho desconectado pelo celular.`);
                await s.auth.limpar().catch(() => {});
                s.sock = null;
                definir(s, 'DESCONECTADO', { numero: null, qr: null, erro: 'O aparelho foi desconectado pelo celular. Conecte de novo.' });
                h.pareado(s.uid, null);
                return;
            }
            s.tentativas += 1;
            const espera = Math.min(60, 2 ** Math.min(s.tentativas, 6)) * 1000;
            definir(s, 'RECONECTANDO', { erro: `Conexão caiu (código ${codigo || '?'}). Nova tentativa em ${espera / 1000}s.` });
            s.timer = setTimeout(() => { if (!s.pausada) conectar(s).catch(e => falha(s, e)); }, espera);
        }
    });

    sock.ev.on('groups.update', ups => ups.forEach(u => u.subject && nomesGrupos.set(u.id, u.subject)));
    sock.ev.on('messaging-history.set', ({ messages }) => { if (atual()) (messages || []).forEach(m => processar(s, m, true)); });
    sock.ev.on('messages.upsert', ({ messages, type }) => { if (atual()) (messages || []).forEach(m => processar(s, m, type !== 'notify')); });
    // Edições e exclusões também chegam por aqui (depende da versão do WhatsApp)
    sock.ev.on('messages.update', updates => {
        if (!atual()) return;
        for (const { key, update } of updates || []) {
            if (!key?.remoteJid?.endsWith('@g.us') || !h.gruposDe(s.uid).includes(key.remoteJid)) continue;
            const apagada = update?.messageStubType === 1 || update?.message === null ||
                (update?.message && idApagado(update.message));
            if (apagada) {
                const apagaId = (update?.message && idApagado(update.message)) || key.id;
                h.mensagem({ apagaId, chatId: key.remoteJid, timestamp: Date.now(), historico: false, viaUid: s.uid }).catch(e => console.error('⚠️  [WHATSAPP] Exclusão:', e.message));
                continue;
            }
            const editada = update?.message?.editedMessage?.message || update?.message?.protocolMessage?.editedMessage;
            if (editada) {
                processar(s, { key: { ...key, id: `${key.id}:edit:${Date.now()}` }, participant: key.participant, message: { protocolMessage: { key, editedMessage: editada } }, messageTimestamp: Math.floor(Date.now() / 1000) }, false);
            }
        }
    });
}

function falha(s, e) {
    console.error(`❌ [WHATSAPP] ${s.uid}: falha ao conectar:`, e.message);
    definir(s, 'ERRO', { erro: e.message });
    s.timer = setTimeout(() => { if (!s.pausada) conectar(s).catch(err => falha(s, err)); }, 30000);
}

function ativas() { return [...sessoes.values()].filter(s => !s.pausada && s.sock); }

async function liberarVaga(uidNovo) {
    const outras = ativas().filter(s => s.uid !== uidNovo);
    while (outras.length >= MAX_ATIVAS) {
        const plantao = h.liderPlantao();
        outras.sort((a, b) => (a.uid === plantao) - (b.uid === plantao) || a.ativadoEm - b.ativadoEm);
        const saida = outras.shift();
        await pausar(saida.uid, 'Pausado para liberar memória (sessão guardada). Reconecta sozinho ao assumir o plantão.');
    }
}

// Liga (ou religa) a sessão de um usuário
async function ativar(uid) {
    if (!baileys) { const e = new Error('Biblioteca do WhatsApp não instalada. Rode "npm install".'); e.status = 503; throw e; }
    const s = sessao(uid);
    s.ativadoEm = Date.now();
    if (!s.pausada && s.sock) return status(uid);
    await liberarVaga(uid);
    s.aguardandoDesde = 0;
    await conectar(s).catch(e => falha(s, e));
    return status(uid);
}

async function pausar(uid, motivo = null) {
    const s = sessao(uid);
    s.pausada = true;
    clearTimeout(s.timer);
    const sock = s.sock;
    s.sock = null;
    if (sock) { try { sock.end(undefined); } catch (_) {} }
    definir(s, 'PAUSADO', { qr: null, erro: motivo });
}

async function desconectar(uid) {
    const s = sessao(uid);
    s.pausada = true;
    clearTimeout(s.timer);
    try { if (s.sock) await s.sock.logout(); } catch (_) {}
    s.sock = null;
    try { const auth = s.auth || await abrirAuth(uid); await auth.limpar(); } catch (_) {}
    definir(s, 'DESCONECTADO', { numero: null, qr: null, erro: null });
    h.pareado(uid, null);
}

function status(uid) {
    if (!baileys) return { estado: 'INDISPONIVEL', erro: 'Biblioteca do WhatsApp não instalada.' };
    const s = sessoes.get(uid);
    if (!s) return { estado: 'PAUSADO', numero: null, qr: null, erro: null };
    return { estado: s.estado, numero: s.numero, qr: s.qr, erro: s.erro };
}

function exigir(uid) {
    const s = sessoes.get(uid);
    if (!s || !s.sock || s.estado !== 'CONECTADO') {
        const e = new Error('O WhatsApp do líder de plantão não está conectado. Ele precisa conectar em "Meu perfil".'); e.status = 409; throw e;
    }
    return s;
}

async function listarGrupos(uid) {
    const s = exigir(uid);
    const grupos = await s.sock.groupFetchAllParticipating();
    return Object.values(grupos)
        .map(g => { nomesGrupos.set(g.id, g.subject); return { id: g.id, nome: g.subject || 'Grupo sem nome', membros: g.participants?.length || 0 }; })
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function enviarTexto(uid, jid, texto) { return exigir(uid).sock.sendMessage(jid, { text: texto }); }

async function enviarDocumento(uid, jid, conteudo, nomeArquivo, legenda) {
    return exigir(uid).sock.sendMessage(jid, { document: Buffer.from(conteudo, 'utf-8'), fileName: nomeArquivo, mimetype: 'text/plain', caption: legenda });
}

async function enviarArquivo(uid, jid, buffer, nomeArquivo, mimetype, legenda) {
    return exigir(uid).sock.sendMessage(jid, { document: buffer, fileName: nomeArquivo, mimetype, caption: legenda });
}

async function pedirCodigo(uid, numero) {
    const s = sessoes.get(uid);
    if (!s || !s.sock || s.estado !== 'AGUARDANDO_PAREAMENTO') {
        const e = new Error(s?.estado === 'CONECTADO' ? 'O WhatsApp já está conectado.' : 'Aguarde o QR aparecer e tente de novo.'); e.status = 409; throw e;
    }
    const n = String(numero || '').replace(/\D/g, '');
    if (n.length < 12) { const e = new Error('Digite o número com 55 + DDD + número. Ex.: 5522998765432'); e.status = 400; throw e; }
    const codigo = await s.sock.requestPairingCode(n);
    return codigo?.match(/.{1,4}/g)?.join('-') || codigo;
}

async function iniciar(opcoes, uidsParaLigar = []) {
    h = { ...h, ...opcoes };
    try {
        baileys = require('@whiskeysockets/baileys');
        logger = require('pino')({ level: 'silent' });
    } catch (e) {
        console.error('⚠️  [WHATSAPP] Biblioteca não instalada — rode "npm install". O painel funciona, mas sem WhatsApp.');
        return;
    }
    for (const uid of uidsParaLigar.slice(0, MAX_ATIVAS)) {
        sessao(uid).ativadoEm = Date.now();
        conectar(sessao(uid)).catch(e => falha(sessao(uid), e));
    }
}

module.exports = {
    MAX_ATIVAS, iniciar, ativar, pausar, desconectar, status, listarGrupos, enviarTexto, enviarDocumento, enviarArquivo, pedirCodigo,
    nomesGrupos, disponivel: () => !!baileys
};

// =====================================================================
// CONEXÃO COM O WHATSAPP (Baileys / aparelho conectado)
// - Só lê os grupos escolhidos na tela de Configurações
// - Nunca responde nos grupos; só envia quando VOCÊ manda publicar
// - Sessão fica guardada (pasta ./dados ou Firestore) e reconecta sozinha
// =====================================================================
const fs = require('fs');
const path = require('path');
const store = require('./store');

let baileys = null;
let sock = null;
let sessao = null;
let tentativas = 0;
let timerReconexao = null;
let handlers = { mensagem: async () => {} };
const nomesGrupos = new Map();

const status = { estado: 'DESLIGADO', qr: null, numero: null, erro: null, desde: null };

function definirEstado(novo, extra = {}) {
    Object.assign(status, { estado: novo, desde: new Date().toISOString() }, extra);
}

const PASTA_SESSAO = path.join(store.PASTA_DADOS, 'sessao_whatsapp');

async function abrirSessao() {
    if (store.db) {
        const usarSessaoFirestore = require('./sessaoFirestore');
        return usarSessaoFirestore(store.db, baileys);
    }
    const { state, saveCreds } = await baileys.useMultiFileAuthState(PASTA_SESSAO);
    return { state, saveCreds, limpar: async () => fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }) };
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

function timestampMs(t) {
    if (!t) return Date.now();
    const n = typeof t === 'object' ? (t.toNumber ? t.toNumber() : Number(t.low)) : Number(t);
    return n * 1000;
}

async function nomeDoGrupo(jid) {
    if (nomesGrupos.has(jid)) return nomesGrupos.get(jid);
    try {
        const meta = await sock.groupMetadata(jid);
        nomesGrupos.set(jid, meta.subject);
        return meta.subject;
    } catch (_) { return ''; }
}

async function processar(m, historico) {
    try {
        const chatId = m.key?.remoteJid || '';
        if (!chatId.endsWith('@g.us') || !m.message) return;
        const texto = textoDaMensagem(m.message);
        if (!texto) return;
        const editado = idEditado(m.message);
        await handlers.mensagem({
            id: m.key.id,
            editaId: editado || null,
            chatId,
            grupoNome: await nomeDoGrupo(chatId),
            autor: m.pushName || (m.key.participant || '').split('@')[0],
            texto,
            timestamp: timestampMs(m.messageTimestamp),
            fromMe: !!m.key.fromMe,
            historico
        });
    } catch (e) {
        console.error('⚠️  [WHATSAPP] Erro ao processar mensagem:', e.message);
    }
}

async function conectar() {
    clearTimeout(timerReconexao);
    definirEstado('CONECTANDO', { qr: null, erro: null });
    sessao = await abrirSessao();
    const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const logger = require('pino')({ level: 'silent' });

    sock = baileys.default({
        version,
        logger,
        auth: {
            creds: sessao.state.creds,
            keys: baileys.makeCacheableSignalKeyStore(sessao.state.keys, logger)
        },
        browser: baileys.Browsers ? baileys.Browsers.macOS('Chrome') : ['Caveira Bot', 'Chrome', '120.0.0'],
        markOnlineOnConnect: false,          // não "rouba" as notificações do seu celular
        syncFullHistory: false,
        shouldIgnoreJid: jid => !jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
        getMessage: async () => undefined
    });

    sock.ev.on('creds.update', () => sessao.saveCreds().catch(e => console.error('Erro ao salvar sessão:', e.message)));

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) definirEstado('AGUARDANDO_PAREAMENTO', { qr });
        if (connection === 'open') {
            tentativas = 0;
            definirEstado('CONECTADO', { qr: null, numero: (sock.user?.id || '').split(':')[0].split('@')[0] });
            console.log(`💀 [WHATSAPP] Conectado (${status.numero}). Lendo apenas os grupos escolhidos, em silêncio.`);
            try {
                const grupos = await sock.groupFetchAllParticipating();
                Object.values(grupos).forEach(g => nomesGrupos.set(g.id, g.subject));
            } catch (_) {}
        }
        if (connection === 'close') {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            if (codigo === baileys.DisconnectReason.loggedOut) {
                console.log('🔌 [WHATSAPP] Aparelho desconectado pelo celular. Limpando sessão para novo pareamento.');
                await sessao.limpar().catch(() => {});
                definirEstado('DESCONECTADO', { erro: 'O aparelho foi desconectado. Conecte novamente.' });
                timerReconexao = setTimeout(conectar, 3000);
                return;
            }
            tentativas += 1;
            const espera = Math.min(60, 2 ** Math.min(tentativas, 6)) * 1000;
            definirEstado('RECONECTANDO', { erro: `Conexão caiu (código ${codigo || '?'}). Nova tentativa em ${espera / 1000}s.` });
            timerReconexao = setTimeout(() => conectar().catch(erroFatal), espera);
        }
    });

    sock.ev.on('groups.update', updates => updates.forEach(u => u.subject && nomesGrupos.set(u.id, u.subject)));

    sock.ev.on('messaging-history.set', ({ messages }) => {
        (messages || []).forEach(m => processar(m, true));
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        (messages || []).forEach(m => processar(m, type !== 'notify'));
    });
}

function erroFatal(e) {
    console.error('❌ [WHATSAPP] Falha ao conectar:', e.message);
    definirEstado('ERRO', { erro: e.message });
    timerReconexao = setTimeout(() => conectar().catch(erroFatal), 30000);
}

async function iniciar(opcoes) {
    handlers = { ...handlers, ...opcoes };
    try {
        baileys = require('@whiskeysockets/baileys');
    } catch (e) {
        definirEstado('INDISPONIVEL', { erro: 'Biblioteca do WhatsApp não instalada. Rode "npm install".' });
        console.error('⚠️  [WHATSAPP] Biblioteca não instalada — rode "npm install". O painel funciona, mas sem WhatsApp.');
        return;
    }
    conectar().catch(erroFatal);
}

function exigirConexao() {
    if (!sock || status.estado !== 'CONECTADO') {
        const e = new Error('WhatsApp não está conectado. Abra Configurações > WhatsApp.'); e.status = 409; throw e;
    }
}

async function listarGrupos() {
    exigirConexao();
    const grupos = await sock.groupFetchAllParticipating();
    return Object.values(grupos)
        .map(g => { nomesGrupos.set(g.id, g.subject); return { id: g.id, nome: g.subject || 'Grupo sem nome', membros: g.participants?.length || 0 }; })
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function enviarTexto(jid, texto) {
    exigirConexao();
    return sock.sendMessage(jid, { text: texto });
}

async function enviarDocumento(jid, conteudo, nomeArquivo, legenda) {
    exigirConexao();
    return sock.sendMessage(jid, { document: Buffer.from(conteudo, 'utf-8'), fileName: nomeArquivo, mimetype: 'text/plain', caption: legenda });
}

async function pedirCodigo(numero) {
    if (!sock || status.estado !== 'AGUARDANDO_PAREAMENTO') {
        const e = new Error(status.estado === 'CONECTADO' ? 'O WhatsApp já está conectado.' : 'Aguarde alguns segundos até o QR aparecer e tente de novo.');
        e.status = 409; throw e;
    }
    const n = String(numero || '').replace(/\D/g, '');
    if (n.length < 12) { const e = new Error('Digite o número com 55 + DDD + número. Ex.: 5522998765432'); e.status = 400; throw e; }
    const codigo = await sock.requestPairingCode(n);
    return codigo?.match(/.{1,4}/g)?.join('-') || codigo;
}

async function desconectar() {
    clearTimeout(timerReconexao);
    try { if (sock) await sock.logout(); } catch (_) {}
    try { if (sessao) await sessao.limpar(); } catch (_) {}
    definirEstado('DESCONECTADO', { numero: null, qr: null });
    timerReconexao = setTimeout(() => conectar().catch(erroFatal), 2000);
}

module.exports = {
    iniciar, status, listarGrupos, enviarTexto, enviarDocumento, pedirCodigo, desconectar,
    nomesGrupos
};

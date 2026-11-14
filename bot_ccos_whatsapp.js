// ==========================================
// CCOS - CAVEIRA BOT (MÓDULO WHATSAPP MULTI-DEVICE & API WEB)
// MONITOR SILENCIOSO DE GRUPOS + ENVIO DE E-MAILS + API PARA O APP
// ==========================================
require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    proto
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// ==========================================
// 1. CONFIGURAÇÕES E BANCO DE DADOS
// ==========================================
const DOC_PLANTAO_ATIVO = 'plantao_ativo_atual';
const COLECAO_USUARIOS = 'usuarios_sistema';
const COLECAO_HISTORICO = 'historico_escalas';
const COLECAO_OPERACOES = 'operacoes_bordo';

if (!admin.apps.length && process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (e) {
        console.warn("⚠️ Firebase credentials parse error:", e.message);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

// ==========================================
// 2. PARÂMETROS OPERACIONAIS DOS GRUPOS E LÍDER
// ==========================================
let GRUPOS_MONITORADOS = [
    process.env.WHATSAPP_GRUPO_1 || '',
    process.env.WHATSAPP_GRUPO_2 || ''
].filter(Boolean);

const NUMERO_LIDER_RUDDGERO = process.env.WHATSAPP_NUMERO_LIDER || '5522999999999@s.whatsapp.net';

// Sessões privadas e memória volátil de feed
const sessoesPrivadas = new Map();
let feedInterceptado = [];
let sockWhatsApp = null;
let statusConexaoWhatsApp = 'DESCONECTADO';
let qrCodeAtual = null;

// Memória local de operações de bordo
let operacoesBordo = [
    {
        id: 1,
        tipo: 'FORNECIMENTO DE RANCHO',
        navio: 'MARAN COURAGE',
        terminal: 'T-Ore',
        fornecedor: 'Distribuidora Marítima Ltda',
        veiculo: 'CAMINHÃO - Placa ABC-1234',
        placa: 'ABC1234',
        horaInicial: '14:20h',
        horaFinal: '16:40h',
        finalizada: true,
        emailEnviado: false
    },
    {
        id: 2,
        tipo: 'DESEMBARQUE DE TRIPULANTES',
        navio: 'YUAN DONG HAI',
        terminal: 'T-Oil',
        fornecedor: 'Agência Marítima Ocean',
        veiculo: 'VAN EXECUTIVA - Placa XYZ-9876',
        placa: 'XYZ9876',
        horaInicial: '15:10h',
        horaFinal: '',
        finalizada: false,
        emailEnviado: false
    }
];

// ==========================================
// 3. TRANSPORTE DE E-MAIL (NODEMAILER / SMTP)
// ==========================================
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
    console.log('✉️ [EMAIL] Servidor SMTP configurado com sucesso!');
} else {
    console.log('ℹ️ [EMAIL] Credenciais SMTP não preenchidas no .env. Disparos serão gerados para Outlook / Webhooks.');
}

async function enviarEmailOperacao(op, dataPlantao) {
    const assunto = `Assunto: ${op.tipo} - ${op.navio} - ${op.terminal.toUpperCase()} - ${(dataPlantao || '14/11/2026').replace(/\//g, '-')}`;
    const destinatarios = process.env.EMAIL_DESTINATARIOS || 'operacoes@ferroport.com.br, supervisao@ferroport.com.br, ccos@ferroport.com.br';
    
    const corpo = `${assunto}

Prezados, boa tarde!

Registro a operação de ${op.tipo.toLowerCase()}:

	✓ Tipo: ${op.tipo}
	✓ Data: ${dataPlantao || new Date().toLocaleDateString('pt-BR')}
	✓ Horário inicial: ${op.horaInicial}                              Horário final: ${op.horaFinal}
	✓ Terminal: ${op.terminal}
	✓ Navio: ${op.navio}
	✓ Empresa responsável/ Prestador: ${op.fornecedor}
	✓ Veículo utilizado: ${op.veiculo}
	✓ Autorizado por (Autoridades): S/A
	✓ Autorizados por (Terminal): S/A
	✓ Observações: S/A
	✓ Procedimentos de segurança realizados: (Identificação, verificação das autorizações, Check List, Briefing de segurança, inspeções, acompanhamento e monitoramento).
	✓ Status: Sem alteração
	✓ Evidências: Em anexo

Informo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;

    if (transporter) {
        try {
            await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to: destinatarios,
                subject: assunto,
                text: corpo
            });
            op.emailEnviado = true;
            console.log(`✉️ [EMAIL ENVIADO]: ${assunto}`);
            return { sucesso: true, enviadoViaSmtp: true };
        } catch (err) {
            console.error(`❌ [ERRO AO ENVIAR EMAIL]:`, err.message);
            return { sucesso: false, erro: err.message };
        }
    } else {
        console.log(`📝 [EMAIL MINUTA PRONTA]: Disparo registrado para ${op.tipo} - ${op.navio}`);
        return { sucesso: true, enviadoViaSmtp: false, minuta: corpo };
    }
}

// ==========================================
// 4. FILTROS ANTI-RUÍDO E S.O.S
// ==========================================
const SAUDACOES_GENERICAS = [
    'bom dia', 'boa tarde', 'boa noite', 'valeu', 'obrigado', 'obrigada',
    'ok', 'blz', 'beleza', 'recebido', 'ciente', 'show', 'top', 'joia',
    'sim', 'nao', 'não', 'positivo', 'opa', 'olá', 'ola', 'tmj'
];

function ehMensagemRuido(texto) {
    if (!texto || typeof texto !== 'string') return true;
    const tLimpo = texto.trim().toLowerCase();
    if (tLimpo.length < 4) return true;
    if (SAUDACOES_GENERICAS.includes(tLimpo)) return true;
    if (/^(k{3,}|ha{2,}|rs{2,})$/i.test(tLimpo)) return true;
    return false;
}

const PALAVRAS_CHAVE_EMERGENCIA = [
    'acidente', 'incêndio', 'incendio', 'ferido', 'ambulância', 'ambulancia',
    'vazamento', 'invasão', 'invasao', 'socorrido', 'alagamento', 'sinistro',
    'queda', 'colisão', 'colisao', 'óbito', 'obito', 'fogo'
];

function ehOcorrenciaCritica(texto) {
    if (!texto) return false;
    const tLower = texto.toLowerCase();
    return PALAVRAS_CHAVE_EMERGENCIA.some(kw => tLower.includes(kw));
}

// Baixa automática de veículos por placa e disparo de e-mail de bordo
function tentarBaixaVeiculo(atividades, textoSaida) {
    const placaMatch = textoSaida.toUpperCase().match(/[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}/);
    if (!placaMatch) return false;

    const placaAlvo = placaMatch[0].replace('-', '');
    const agora = new Date();
    const hora = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) + 'h';

    // 1. Atualiza nas atividades da Seção 4
    let atualizouAtiv = false;
    for (let i = atividades.length - 1; i >= 0; i--) {
        const ativ = atividades[i];
        const ativLimpa = ativ.toUpperCase().replace('-', '');

        if (ativLimpa.includes(placaAlvo)) {
            if (!ativ.toLowerCase().includes('saída às') && !ativ.toLowerCase().includes('saida as')) {
                atividades[i] = `${ativ.trim()} Saída às ${hora}.`;
                atualizouAtiv = true;
                break;
            }
        }
    }

    // 2. Localiza em operacoesBordo para finalizar e disparar e-mail
    const op = operacoesBordo.find(o => !o.finalizada && o.veiculo.toUpperCase().replace('-', '').includes(placaAlvo));
    if (op) {
        op.horaFinal = hora;
        op.finalizada = true;
        console.log(`🚢 [OPERAÇÃO FINALIZADA]: ${op.tipo} - ${op.navio} (${placaAlvo})`);
        enviarEmailOperacao(op, new Date().toLocaleDateString('pt-BR')).then(res => {
            if (sockWhatsApp && NUMERO_LIDER_RUDDGERO) {
                sockWhatsApp.sendMessage(NUMERO_LIDER_RUDDGERO, {
                    text: `✉️ *E-MAIL OPERACIONAL GERADO COM SUCESSO!*\n\n🚢 *Operação:* ${op.tipo}\n⚓ *Navio:* ${op.navio}\n🚗 *Veículo:* ${op.veiculo}\n🕒 *Saída:* ${op.horaFinal}\n\n${res.enviadoViaSmtp ? '✅ Enviado automaticamente via SMTP corporativo.' : '📋 Minuta pronta disponível no App Web.'}`
                }).catch(() => {});
            }
        });
    }

    return atualizouAtiv || !!op;
}

// ==========================================
// 5. BANCO DE DADOS E FORMATAÇÃO DO RELATÓRIO
// ==========================================
async function carregarPlantaoAtivo() {
    if (!db) return criarPlantaoPadrao();
    try {
        const doc = await db.collection(DOC_PLANTAO_ATIVO).doc('dados').get();
        if (doc.exists) return doc.data();
    } catch (e) {
        console.error("Erro ao carregar plantão no WhatsApp:", e);
    }
    return criarPlantaoPadrao();
}

async function salvarPlantaoAtivo(dados) {
    if (!db) return;
    try {
        await db.collection(DOC_PLANTAO_ATIVO).doc('dados').set(dados, { merge: true });
    } catch (e) {
        console.error("Erro ao salvar plantão no WhatsApp:", e);
    }
}

function criarPlantaoPadrao() {
    const agora = new Date();
    const data = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return {
        status: 'ABERTO',
        tipoTurno: 'NOTURNO',
        data: data,
        efetivoCCOS: '✓ S/A',
        vtr: { modelo: 'L200', placa: 'TDG-8C89', kmInicial: '19.228', kmFinal: '19.235' },
        sistemas: {
            cftv: '✓ 02 câmeras ausentes:\nCâmera fixa – Poste 38;\nCâmera fixa – Portão 04 da Filtragem.\nObs: Câmeras fixas - Postes 12 e 24 oscilando.',
            ca: '✓ S/A',
            ocr: { assertividade: '83,72%', leituras: '43' }
        },
        atividades: [],
        avisos: [
            { id: 1, titulo: 'BAGAGENS RETIDAS NA RECEITA FEDERAL - T-OIL', desc: 'Acompanhar situação das bagagens dos prestadores de serviços dos navios Yuan Dong Hai e Seaways Cape Henry retidas na RFB para inspeção.' },
            { id: 2, titulo: 'ADEQUAÇÕES NAS INSTALAÇÕES DA PF E RFB', desc: 'Acompanhar abertura da porta de acesso e instalação de dois aparelhos de ar-condicionado pela equipe da Facilities.' },
            { id: 3, titulo: 'VISITA DE FAMILIARES - PDA E VAST', desc: 'Atentar para a visita de familiares programada para o dia 14/11/2026 (PDA e VAST).' },
            { id: 4, titulo: 'URNAS DA CIPA – CHAVES', desc: 'Verificar e informar o status atual das chaves das urnas da CIPA.' },
            { id: 5, titulo: 'MELHORIAS CFTV, CA E INFRAESTRUTURA ELÉTRICA', desc: 'Trecho inicial GATE 1 ao poste 31. Aguardando cronograma conjunto da Elétrica e DIGITAL.' }
        ],
        movimentacaoNavios: { tore: {}, toil: {} },
        ocorrencias: ['✓ S/A'],
        passagemTurno: { equipeSaindo: '', equipeAssumindo: '' }
    };
}

function formatarRelatorioFinal(plantao) {
    const turno = plantao.tipoTurno || 'NOTURNO';
    const data = plantao.data || new Date().toLocaleDateString('pt-BR');

    const baseAdmin = '✓ Realizadas atividades administrativas.';
    const baseRonda = '✓ Executada ronda em todo o terminal, com apoio do Supervisor Sunset.';
    const extras = (plantao.atividades || []).filter(a => {
        const s = a.toLowerCase();
        return !s.includes('iniciar plantão') && !s.includes('iniciar plantao') && !s.includes('🟢');
    });

    const blocoAtividades = [baseAdmin, baseRonda, ...extras].join('\n');

    const avisos = plantao.avisos || [];
    const blocoAvisos = avisos.length > 0
        ? avisos.map((av, idx) => `*5.${idx + 1}. ${typeof av === 'object' ? av.titulo : 'AVISO'}*\n${typeof av === 'object' ? av.desc : av}`).join('\n\n')
        : '✓ S/A';

    return `*RELATÓRIO DO TURNO - ${turno}*
Data: ${data}

*1. EFETIVO CCOS*
${plantao.efetivoCCOS || '✓ S/A'}

*2. VIATURA – VTR*
Veículo: ${plantao.vtr?.modelo || 'L200'}
Placa: ${plantao.vtr?.placa || 'TDG-8C89'}
KM inicial: ${plantao.vtr?.kmInicial || '19.228'}
KM final: ${plantao.vtr?.kmFinal || '19.235'}

*3. SISTEMAS*
*CFTV*
${plantao.sistemas?.cftv || '✓ S/A'}

*CA - CONTROLE DE ACESSO*
${plantao.sistemas?.ca || '✓ S/A'}

*OCR – RECONHECIMENTO DE PLACAS*
Assertividade: ${plantao.sistemas?.ocr?.assertividade || '83,72%'};
Total de leituras: ${plantao.sistemas?.ocr?.leituras || '43'} veículos.

*4. ATIVIDADES REALIZADAS*
${blocoAtividades}

*5. AVISOS E AÇÕES DE ACOMPANHAMENTO*
${blocoAvisos}

*6. MOVIMENTAÇÃO DE NAVIOS*
*T-ORE*
MARAN COURAGE: Previsão de desatracação em 14/11 às 11h30.
MARLENE OLDENDORFF: DC e DP disponíveis.

*T-OIL*
YUAN DONG HAI: Desatracado às 20h57.
EAGLE PAULINIA: Sem alteração operacional.

*7. OCORRÊNCIAS:*
${(plantao.ocorrencias && plantao.ocorrencias.length > 0) ? plantao.ocorrencias.join('\n') : '✓ S/A'}

*8. PASSAGEM DE TURNO*
*EQUIPE SAINDO:*
${plantao.passagemTurno?.equipeSaindo || 'Gustavo Ramos, Italo Nunes e Rodrigo Chaves'}

*EQUIPE ASSUMINDO:*
${plantao.passagemTurno?.equipeAssumindo || 'Renan Neves, Ewerton Brito e Mariana Rodrigues'}`;
}

// ==========================================
// 6. MOTOR WHATSAPP BAILEYS
// ==========================================
async function iniciarBotWhatsApp() {
    try {
        const pastaAuth = path.join(__dirname, 'auth_whatsapp_ccos');
        const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);
        const { version } = await fetchLatestBaileysVersion();

        sockWhatsApp = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: true,
            browser: ['CCOS Caveira Bot', 'Chrome', '120.0.0']
        });

        sockWhatsApp.ev.on('creds.update', saveCreds);

        sockWhatsApp.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                qrCodeAtual = qr;
                statusConexaoWhatsApp = 'AGUARDANDO_QR';
                console.log('📲 [WHATSAPP]: QR Code gerado! Abra o WhatsApp > Aparelhos Conectados > Ler QR Code.');
            }
            if (connection === 'close') {
                statusConexaoWhatsApp = 'DESCONECTADO';
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('⚠️ [WHATSAPP] Conexão encerrada. Reconectando...', shouldReconnect);
                if (shouldReconnect) iniciarBotWhatsApp();
            } else if (connection === 'open') {
                statusConexaoWhatsApp = 'CONECTADO';
                qrCodeAtual = null;
                console.log('💀 [WHATSAPP] CAVEIRA BOT ONLINE E MONITORANDO EM SILÊNCIO!');
            }
        });

        // Escuta silenciosa de mensagens
        sockWhatsApp.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const m of messages) {
                if (!m.message || m.key.fromMe) continue;

                const chatId = m.key.remoteJid;
                const ehGrupo = chatId.endsWith('@g.us');
                const remetente = m.key.participant || chatId;
                const nomeAutor = m.pushName || remetente.split('@')[0];

                const texto = m.message.conversation ||
                              m.message.extendedTextMessage?.text ||
                              m.message.imageMessage?.caption ||
                              '';

                if (!texto) continue;

                const ehGrupoMonitorado = GRUPOS_MONITORADOS.length === 0 || GRUPOS_MONITORADOS.includes(chatId);

                // ==========================================
                // CASO A: MENSAGEM NO GRUPO MONITORADO (100% SILENCIOSO)
                // ==========================================
                if (ehGrupo && ehGrupoMonitorado) {
                    if (ehMensagemRuido(texto)) {
                        feedInterceptado.push({
                            id: Date.now(),
                            hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + 'h',
                            grupo: 'Grupo Operacional',
                            autor: nomeAutor,
                            texto: texto,
                            tipo: 'RUIDO'
                        });
                        continue;
                    }

                    console.log(`📡 [GRUPO MONITORADO] Captado de ${nomeAutor}: "${texto}"`);
                    const plantao = await carregarPlantaoAtivo();
                    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + 'h';

                    // Registra no feed para a interface Web
                    feedInterceptado.push({
                        id: Date.now(),
                        hora: hora,
                        grupo: 'Grupo Operacional',
                        autor: nomeAutor,
                        texto: texto,
                        tipo: ehOcorrenciaCritica(texto) ? 'SOS' : 'ATIVIDADE'
                    });

                    // Alerta S.O.S urgente
                    if (ehOcorrenciaCritica(texto)) {
                        const itemOcorrencia = `✓ ${hora} ${texto} [Postado por: ${nomeAutor}]`;
                        if (!plantao.ocorrencias || plantao.ocorrencias[0] === '✓ S/A') plantao.ocorrencias = [];
                        plantao.ocorrencias.push(itemOcorrencia);
                        await salvarPlantaoAtivo(plantao);

                        if (NUMERO_LIDER_RUDDGERO) {
                            await sockWhatsApp.sendMessage(NUMERO_LIDER_RUDDGERO, {
                                text: `🚨 *ALERTA CCOS - OCORRÊNCIA DETECTADA EM GRUPO!*\n\n🕒 *Horário:* ${hora}\n👤 *Autor:* ${nomeAutor}\n📄 *Relato:* "${texto}"\n\n📁 *Inserido na Seção 7 do Relatório.*`
                            }).catch(() => {});
                        }
                        continue;
                    }

                    // Baixa automática de veículos
                    const ehSaida = texto.toLowerCase().includes('saída') || texto.toLowerCase().includes('saida');
                    if (ehSaida && tentarBaixaVeiculo(plantao.atividades, texto)) {
                        await salvarPlantaoAtivo(plantao);
                        console.log(`✅ [VEÍCULO] Saída cravada na placa correspondente.`);
                        continue;
                    }

                    // Registra atividade padrão
                    const itemAtividade = `✓ ${hora} ${texto} [Autor: ${nomeAutor}]`;
                    if (!plantao.atividades) plantao.atividades = [];
                    plantao.atividades.push(itemAtividade);
                    await salvarPlantaoAtivo(plantao);
                    continue;
                }

                // ==========================================
                // CASO B: COMANDO NO PRIVADO DO LÍDER
                // ==========================================
                if (!ehGrupo) {
                    const comando = texto.trim().toLowerCase();
                    const plantao = await carregarPlantaoAtivo();

                    if (comando === 'status' || comando === 'relatorio' || comando === 'relatório') {
                        const relatorioAtual = formatarRelatorioFinal(plantao);
                        await sockWhatsApp.sendMessage(chatId, { text: `📊 *PRÉVIA EM TEMPO REAL:*\n\n${relatorioAtual}` });
                        continue;
                    }

                    if (comando === 'disparar' || comando === 'publicar') {
                        const relatorioFinal = formatarRelatorioFinal(plantao);
                        const nomeArquivo = `Relatorio_Turno_${plantao.tipoTurno || 'NOTURNO'}_${new Date().toLocaleDateString('pt-BR').replace(/\//g, '-')}.txt`;
                        const caminhoArquivo = path.join(__dirname, nomeArquivo);

                        fs.writeFileSync(caminhoArquivo, relatorioFinal, 'utf-8');

                        const grupoAlvo = GRUPOS_MONITORADOS[0];
                        if (grupoAlvo) {
                            await sockWhatsApp.sendMessage(grupoAlvo, { text: relatorioFinal });
                            await sockWhatsApp.sendMessage(grupoAlvo, {
                                document: fs.readFileSync(caminhoArquivo),
                                fileName: nomeArquivo,
                                mimetype: 'text/plain',
                                caption: `📄 *Arquivo oficial emitido pelo CCOS:* \`${nomeArquivo}\``
                            });
                            await sockWhatsApp.sendMessage(chatId, { text: `🚀 *Relatório e arquivo .txt disparados com sucesso no grupo!*` });
                        }
                        continue;
                    }
                }
            }
        });
    } catch (e) {
        console.error("❌ Erro ao iniciar Baileys:", e.message);
    }
}

// ==========================================
// 7. SERVIDOR HTTP EXPRESS (API PARA O APP GITHUB PAGES)
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

// Servir os arquivos estáticos se hospedado junto no Render
app.use(express.static(__dirname));

// Endpoint 1: Status Geral do Sistema
app.get('/api/status', async (req, res) => {
    const plantao = await carregarPlantaoAtivo();
    res.json({
        whatsappConexao: statusConexaoWhatsApp,
        qrCode: qrCodeAtual,
        gruposMonitorados: GRUPOS_MONITORADOS.length,
        vtr: plantao.vtr,
        sistemas: plantao.sistemas,
        turno: plantao.tipoTurno,
        data: plantao.data
    });
});

// Endpoint 2: Feed Silencioso Interceptado
app.get('/api/feed', (req, res) => {
    res.json(feedInterceptado.slice(-50).reverse());
});

// Endpoint 3: Operações de Bordo (Rancho / Tripulantes)
app.get('/api/operacoes', (req, res) => {
    res.json(operacoesBordo);
});

// Endpoint 4: Registrar Nova Operação
app.post('/api/operacoes', (req, res) => {
    const { tipo, navio, terminal, fornecedor, veiculo, horaInicial, horaFinal } = req.body;
    const nova = {
        id: Date.now(),
        tipo: tipo || 'FORNECIMENTO DE RANCHO',
        navio: (navio || 'S/N').toUpperCase(),
        terminal: terminal || 'T-Ore',
        fornecedor: fornecedor || 'S/A',
        veiculo: (veiculo || 'S/A').toUpperCase(),
        placa: (veiculo || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        horaInicial: horaInicial || '14:00h',
        horaFinal: horaFinal || '',
        finalizada: !!horaFinal,
        emailEnviado: false
    };
    operacoesBordo.push(nova);
    res.json({ sucesso: true, operacao: nova });
});

// Endpoint 5: Marcar Saída e Liberar E-mail
app.post('/api/operacoes/:id/saida', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const op = operacoesBordo.find(o => o.id === id);
    if (!op) return res.status(404).json({ erro: 'Operação não encontrada' });

    op.horaFinal = req.body.horaFinal || (new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + 'h');
    op.finalizada = true;

    // Dispara envio de e-mail se SMTP estiver configurado
    const resultadoEmail = await enviarEmailOperacao(op, new Date().toLocaleDateString('pt-BR'));

    res.json({ sucesso: true, operacao: op, email: resultadoEmail });
});

// Endpoint 6: Disparar Relatório Oficial nos Grupos
app.post('/api/disparar-relatorio', async (req, res) => {
    const plantao = await carregarPlantaoAtivo();
    const relatorioFinal = formatarRelatorioFinal(plantao);

    if (sockWhatsApp && GRUPOS_MONITORADOS.length > 0) {
        for (const g of GRUPOS_MONITORADOS) {
            await sockWhatsApp.sendMessage(g, { text: relatorioFinal }).catch(() => {});
        }
    }
    res.json({ sucesso: true, mensagem: 'Relatório disparado com sucesso!' });
});

let codigoPairingAtual = null;

async function solicitarPairingCode(numero) {
    if (!sockWhatsApp) throw new Error("Motor do WhatsApp ainda não inicializado no servidor. Aguarde alguns segundos e tente novamente.");
    if (sockWhatsApp.authState?.creds?.registered) {
        statusConexaoWhatsApp = 'CONECTADO';
        throw new Error("O WhatsApp já está registrado e autenticado com sucesso!");
    }
    const numLimpo = String(numero).replace(/\D/g, '');
    if (numLimpo.length < 10) throw new Error("Número inválido. Digite com DDI e DDD (Exemplo: 5522998765432)");

    const code = await sockWhatsApp.requestPairingCode(numLimpo);
    const codeFormatado = code ? (code.match(/.{1,4}/g)?.join('-') || code) : code;
    codigoPairingAtual = codeFormatado;
    console.log(`\n========================================================`);
    console.log(`📲 CÓDIGO DE PAREAMENTO DO WHATSAPP GERADO COM SUCESSO:`);
    console.log(`👉👉👉  ${codeFormatado}  👈👈👈`);
    console.log(`No seu celular: WhatsApp > Aparelhos Conectados > Conectar um Aparelho > Conectar com número de telefone`);
    console.log(`========================================================\n`);
    return codeFormatado;
}

// Endpoint 7: Tela do QR Code Oficial no Navegador para Leitura Fácil
app.get('/qr', (req, res) => {
    if (statusConexaoWhatsApp === 'CONECTADO') {
        return res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head><meta charset="UTF-8"><title>WhatsApp Conectado</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4 font-sans">
                <div class="bg-slate-900 border border-emerald-500/30 p-8 rounded-3xl text-center max-w-md shadow-2xl space-y-4">
                    <div class="text-5xl">🎉</div>
                    <h1 class="text-xl font-bold text-emerald-400">WHATSAPP CONECTADO COM SUCESSO!</h1>
                    <p class="text-sm text-slate-300">O CAVEIRA BOT já está monitorando os grupos silenciosamente em segundo plano.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (!qrCodeAtual) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head><meta charset="UTF-8"><meta http-equiv="refresh" content="3"><title>Gerando QR Code...</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4 font-sans">
                <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl text-center max-w-md shadow-2xl space-y-4">
                    <div class="animate-spin text-4xl">⏳</div>
                    <h1 class="text-base font-bold text-white">Iniciando conexão com WhatsApp...</h1>
                    <p class="text-xs text-slate-400">Aguardando o QR Code ser gerado pela Meta. A página atualiza sozinha em 3 segundos.</p>
                </div>
            </body>
            </html>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Conectar WhatsApp CCOS</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        </head>
        <body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4 font-sans">
            <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl text-center max-w-md shadow-2xl space-y-4">
                <div class="text-3xl">📲</div>
                <h1 class="text-lg font-bold text-white">Conectar WhatsApp - CAVEIRA BOT</h1>
                <p class="text-xs text-slate-300">Abra o WhatsApp no celular &gt; <strong>Aparelhos Conectados</strong> &gt; <strong>Conectar um Aparelho</strong> e aponte para o QR Code abaixo:</p>
                <div class="bg-white p-4 rounded-2xl inline-block shadow-lg mx-auto" id="qrcode"></div>
                <div class="text-[11px] text-emerald-400 font-mono animate-pulse">● Aguardando leitura do celular...</div>
                <script>
                    new QRCode(document.getElementById('qrcode'), {
                        text: ${JSON.stringify(qrCodeAtual)},
                        width: 250,
                        height: 250,
                        colorDark: "#020617",
                        colorLight: "#ffffff",
                        correctLevel: QRCode.CorrectLevel.M
                    });
                    setTimeout(() => window.location.reload(), 15000);
                </script>
            </div>
        </body>
        </html>
    `);
});

// Endpoint 8: API para solicitar o Pairing Code
app.all('/api/pairing-code', async (req, res) => {
    const numero = req.query.numero || req.body?.numero;
    if (!numero) {
        return res.status(400).json({ sucesso: false, erro: 'Informe o número de telefone com DDI e DDD (ex: 5522998765432)' });
    }
    try {
        const code = await solicitarPairingCode(numero);
        res.json({ sucesso: true, codigo: code });
    } catch (err) {
        res.status(500).json({ sucesso: false, erro: err.message });
    }
});

// Endpoint 9: Página Visual para Conectar por Código de 8 Dígitos (Sem Câmera)
app.get('/conectar', (req, res) => {
    if (statusConexaoWhatsApp === 'CONECTADO') {
        return res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head><meta charset="UTF-8"><title>WhatsApp Conectado</title><script src="https://cdn.tailwindcss.com"></script></head>
            <body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4 font-sans">
                <div class="bg-slate-900 border border-emerald-500/30 p-8 rounded-3xl text-center max-w-md shadow-2xl space-y-4">
                    <div class="text-5xl">🎉</div>
                    <h1 class="text-xl font-bold text-emerald-400">WHATSAPP CONECTADO COM SUCESSO!</h1>
                    <p class="text-sm text-slate-300">O CAVEIRA BOT já está monitorando os grupos silenciosamente.</p>
                </div>
            </body>
            </html>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Conectar WhatsApp por Código - CCOS</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4 font-sans">
            <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl max-w-md w-full shadow-2xl space-y-5">
                <div class="text-center space-y-1">
                    <div class="text-3xl">🔢</div>
                    <h1 class="text-lg font-bold text-white">Conectar por Código de 8 Dígitos</h1>
                    <p class="text-xs text-slate-400">Sem câmera e sem QR Code! Digite seu número com DDD:</p>
                </div>

                <div class="space-y-3">
                    <div>
                        <label class="block text-xs text-slate-300 mb-1">Número do WhatsApp (com 55 e DDD):</label>
                        <input type="tel" id="input-numero" placeholder="Ex: 5522998765432" class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-sm text-white font-mono focus:border-indigo-500 focus:outline-none">
                    </div>
                    <button onclick="gerarCodigo()" id="btn-gerar" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition shadow-lg flex items-center justify-center gap-2">
                        <span>⚡</span> Gerar Código de Pareamento
                    </button>
                </div>

                <!-- BOX DO CÓDIGO GERADO -->
                <div id="box-resultado" class="hidden p-5 bg-slate-950 border border-indigo-500/30 rounded-2xl text-center space-y-3">
                    <div class="text-xs text-slate-400 uppercase tracking-wider font-bold">Seu Código de Pareamento:</div>
                    <div id="display-codigo" class="text-3xl font-mono font-black text-emerald-400 tracking-widest bg-slate-900 py-3 rounded-xl border border-emerald-500/30 select-all">
                        ---- ----
                    </div>
                    <div class="text-[11px] text-slate-300 text-left bg-slate-900/60 p-3 rounded-xl border border-slate-800 space-y-1.5">
                        <div class="font-bold text-indigo-400">O que fazer no celular agora:</div>
                        <div>1. Abra o WhatsApp</div>
                        <div>2. Toque em <strong>Aparelhos Conectados &gt; Conectar um Aparelho</strong></div>
                        <div>3. Embaixo da câmera, toque em <strong>"Conectar com número de telefone"</strong></div>
                        <div>4. Digite esse código de 8 dígitos acima!</div>
                    </div>
                </div>

                <div id="box-erro" class="hidden p-3 bg-red-950/50 border border-red-500/30 rounded-xl text-xs text-red-400 text-center"></div>

                <div class="text-center pt-2">
                    <a href="/qr" class="text-[11px] text-slate-500 hover:text-slate-300 underline">Prefere usar QR Code? Clique aqui</a>
                </div>
            </div>

            <script>
                async function gerarCodigo() {
                    const btn = document.getElementById('btn-gerar');
                    const num = document.getElementById('input-numero').value.trim();
                    const boxRes = document.getElementById('box-resultado');
                    const boxErr = document.getElementById('box-erro');
                    const disp = document.getElementById('display-codigo');

                    boxErr.classList.add('hidden');
                    if (!num || num.length < 10) {
                        boxErr.innerText = "Por favor, digite o número completo com DDI (55) e DDD. Ex: 5522998765432";
                        boxErr.classList.remove('hidden');
                        return;
                    }

                    btn.disabled = true;
                    btn.innerHTML = '<span class="animate-spin">⏳</span> Solicitando código à Meta...';

                    try {
                        const r = await fetch('/api/pairing-code?numero=' + encodeURIComponent(num));
                        const d = await r.json();

                        if (d.sucesso && d.codigo) {
                            disp.innerText = d.codigo;
                            boxRes.classList.remove('hidden');
                            btn.innerText = "✓ Código Gerado! Digite no seu celular";
                            btn.className = "w-full py-3 bg-emerald-600 text-white font-bold rounded-xl text-xs";
                        } else {
                            throw new Error(d.erro || "Falha ao gerar código");
                        }
                    } catch (e) {
                        boxErr.innerText = e.message;
                        boxErr.classList.remove('hidden');
                        btn.disabled = false;
                        btn.innerText = "Tentar Novamente";
                    }
                }
            </script>
        </body>
        </html>
    `);
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`🚀 [API CCOS] Servidor HTTP pronto na porta ${PORTA}`);
});

// Inicia Baileys
iniciarBotWhatsApp();

module.exports = { iniciarBotWhatsApp };

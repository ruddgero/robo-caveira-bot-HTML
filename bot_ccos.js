// ==========================================
// CAVEIRA BOT - SISTEMA ERP CCOS (VERSÃO MASTER TELEGRAM INTEGRAL)
// ==========================================
require('dotenv').config();
process.env.GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');

// ==========================================
// 1. VARIÁVEIS DE AMBIENTE & CONFIGURAÇÕES TELEGRAM
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
    console.warn("⚠️ [TELEGRAM] Token não informado (TELEGRAM_BOT_TOKEN / TELEGRAM_TOKEN). Módulo inativo.");
    return;
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('💀 Caveira Bot CCOS (Telegram) iniciado com sucesso em modo Polling!');

// Tratamento de erros de polling do Telegram
bot.on('polling_error', (error) => {
    console.error('⚠️ [TELEGRAM POLLING ERROR]:', error.code || error.message);
});

// ==========================================
// 2. BANCO DE DADOS NA NUVEM (FIREBASE) + CACHES
// ==========================================
if (!process.env.FIREBASE_CREDENTIALS) {
    console.error("FATAL: Variável FIREBASE_CREDENTIALS não encontrada!");
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
console.log('✅ Banco de Dados FIREBASE Conectado com Sucesso!');

const DOC_PLANTAO_ATIVO = 'plantao_ativo_atual';
const COLECAO_USUARIOS = 'usuarios_sistema';
const COLECAO_HISTORICO = 'historico_escalas';

let cachePlantaoCompartilhado = null;
let cacheUsuariosRBAC = new Map(); // [chatIdStr -> { nome, cargo: 'ADMIN' | 'OPERADOR' }]
const cacheUsuariosPrivados = new Map(); // Etapas privadas por chatId

// ==========================================
// 3. SEGURANÇA E RBAC (CONTROLE POR ID DO TELEGRAM)
// ==========================================
function limparIdTelegram(id) {
    if (!id) return "";
    return id.toString().replace(/[^0-9]/g, '').trim();
}

const ID_LIDER_RUDDGERO = "7490152467";

const MAPA_NOMES_OFICIAIS = {
    "7490152467": { nome: "Ruddgero Ribeiro (Líder)", cargo: "ADMIN" },
    "1722571283": { nome: "Felipe Furtado", cargo: "OPERADOR" },
    "9155205028": { nome: "Lais Campos", cargo: "OPERADOR" },
    "6166478365": { nome: "Marcos Duarte", cargo: "OPERADOR" }
};

async function sincronizarUsuariosDoBanco() {
    try {
        db.collection(COLECAO_USUARIOS).doc("000000").delete().catch(() => {});

        db.collection(COLECAO_USUARIOS).onSnapshot((snapshot) => {
            const novoMapa = new Map();
            snapshot.forEach(doc => {
                const idLimpo = limparIdTelegram(doc.id);
                if (idLimpo && idLimpo !== "000000") {
                    const data = doc.data();
                    if (MAPA_NOMES_OFICIAIS[idLimpo] && (!data.nome || data.nome === "Operador CCOS" || data.nome === "Operador")) {
                        data.nome = MAPA_NOMES_OFICIAIS[idLimpo].nome;
                        db.collection(COLECAO_USUARIOS).doc(idLimpo).set({ nome: data.nome }, { merge: true }).catch(() => {});
                    }
                    novoMapa.set(idLimpo, data);
                }
            });
            cacheUsuariosRBAC = novoMapa;
            console.log(`👥 RBAC Sincronizado em tempo real: ${cacheUsuariosRBAC.size} membros carregados.`);
        }, (err) => {
            console.error("Erro no listener de usuários do Firebase:", err);
        });
    } catch (e) {
        console.error("Erro ao configurar sincronização de usuários:", e);
    }
}
sincronizarUsuariosDoBanco();

function verificarPermissao(chatId) {
    const idStr = limparIdTelegram(chatId);
    if (!idStr) return { autorizado: false, isAdmin: false, usuario: null };

    // Líder Supremo tem permissão total garantida
    if (idStr === ID_LIDER_RUDDGERO) {
        return {
            autorizado: true,
            isAdmin: true,
            usuario: cacheUsuariosRBAC.get(idStr) || { nome: "Ruddgero Ribeiro (Líder)", cargo: "ADMIN" }
        };
    }

    const usuario = cacheUsuariosRBAC.get(idStr);
    if (usuario) {
        return {
            autorizado: true,
            isAdmin: usuario.cargo === 'ADMIN',
            usuario
        };
    }

    if (MAPA_NOMES_OFICIAIS[idStr]) {
        return {
            autorizado: true,
            isAdmin: MAPA_NOMES_OFICIAIS[idStr].cargo === 'ADMIN',
            usuario: MAPA_NOMES_OFICIAIS[idStr]
        };
    }

    return { autorizado: false, isAdmin: false, usuario: null };
}

// ==========================================
// 4. TECLADOS UNIFICADOS (CCOS COM MESMA VISUALIZAÇÃO DO LÍDER)
// ==========================================
// CCOS Operadores têm exatamente os mesmos botões do Líder!
const tecladoPrincipal = {
    reply_markup: {
        keyboard: [
            [{ text: "📋 Mural de Informações" }, { text: "📊 Painel de Controle" }],
            [{ text: "🚢 Movimentação / Navios" }, { text: "✉️ E-mails Operacionais" }],
            [{ text: "🚨 Registrar Ocorrência" }, { text: "📝 Registrar Atividade" }],
            [{ text: "📑 Relatório do Turno" }, { text: "🏁 Fechar Turno" }],
            [{ text: "🔄 Passagem da Escala" }, { text: "👥 Gestão de Acessos" }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

const tecladoAdmin = tecladoPrincipal;
const tecladoOperador = tecladoPrincipal; // Mesma visualização para todos

// ==========================================
// 5. INTELIGÊNCIA ARTIFICIAL GEMINI API (SDK OFICIAL)
// ==========================================
let aiClient = null;
if (process.env.GEMINI_API_KEY) {
    try {
        aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        console.log("✨ Gemini AI Oficial (@google/genai) configurado com sucesso.");
    } catch (e) {
        console.error("Falha ao inicializar Gemini AI:", e);
    }
}

// ==========================================
// 6. FUNÇÕES UTILITÁRIAS DE DATA, HORA E HIGIENIZAÇÃO
// ==========================================
function obterDataHoraAtual() {
    const agora = new Date();
    // Força fuso horário de Brasília (UTC-3)
    const optionsData = { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' };
    const optionsHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };

    const data = agora.toLocaleDateString('pt-BR', optionsData);
    const hora = agora.toLocaleTimeString('pt-BR', optionsHora) + 'h';

    return { data, hora, timestamp: agora.getTime() };
}

/**
 * Remove qualquer data (DD/MM/AAAA) ou horário (HH:MMh) que já esteja no início do texto,
 * colchetes envolventes ou símbolos repetidos para evitar "20:07h 20:07h" ou "[07/11/2026 - 20:07h]".
 */
function limparTextoBruto(texto) {
    if (!texto) return '';
    let limpo = texto.trim();

    // Remove colchetes envolventes se houver
    limpo = limpo.replace(/^\[(.*)\]$/s, '$1').trim();

    // Remove marcadores iniciais
    limpo = limpo.replace(/^[✓•\-\*]\s*/, '');

    // Remove carimbos pré-existentes de data tipo 07/11/2026, 07/11/2026 -
    limpo = limpo.replace(/^(\d{2}\/\d{2}\/\d{4}\s*[-–]?\s*)/i, '');

    // Remove repetições de hora tipo 20:07h, 20:07, 20:07h 20:07h
    limpo = limpo.replace(/^(\d{1,2}:\d{2}h?\s*[-–]?\s*)+/i, '');

    // Remove marcadores que possam ter ficado após remoção da data/hora
    limpo = limpo.replace(/^[✓•\-\*]\s*/, '');

    return limpo.trim();
}

/**
 * Envia mensagem garantindo que chegue como bloco único contínuo.
 * Se o Markdown falhar por caracteres especiais do usuário, envia sem parse_mode para não perder a mensagem.
 */
async function enviarMensagemSegura(chatId, texto, opcoes = {}) {
    const limite = 4090;

    // Se couber inteiro, envia em UMA ÚNICA MENSAGEM
    if (texto.length <= limite) {
        try {
            return await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown', ...opcoes });
        } catch (e) {
            // Fallback sem Markdown em caso de erro de sintaxe
            return await bot.sendMessage(chatId, texto, { ...opcoes, parse_mode: undefined });
        }
    }

    // Caso extremo (texto gigante que exceda 4096 caracteres): quebra em parágrafos limpos
    const partes = [];
    let atual = '';
    const linhas = texto.split('\n');

    for (const linha of linhas) {
        if ((atual + '\n' + linha).length > limite) {
            partes.push(atual);
            atual = linha;
        } else {
            atual = atual ? atual + '\n' + linha : linha;
        }
    }
    if (atual) partes.push(atual);

    for (const parte of partes) {
        try {
            await bot.sendMessage(chatId, parte, { parse_mode: 'Markdown', ...opcoes });
        } catch (e) {
            await bot.sendMessage(chatId, parte, { ...opcoes, parse_mode: undefined });
        }
    }
}

/**
 * Envia o relatório completo em mensagem única e também anexa o arquivo de texto (.txt) oficial.
 */
async function enviarRelatorioComArquivo(chatId, texto, nomeArquivo) {
    // 1. Envia a mensagem no Telegram (em bloco único)
    await enviarMensagemSegura(chatId, texto);

    // 2. Envia o arquivo .txt anexo para arquivamento/download
    try {
        const buffer = Buffer.from(texto, 'utf-8');
        await bot.sendDocument(chatId, buffer, {
            caption: `📄 *Arquivo oficial emitido:* \`${nomeArquivo}\``,
            parse_mode: 'Markdown'
        }, {
            filename: nomeArquivo,
            contentType: 'text/plain'
        });
    } catch (e) {
        console.error("Erro ao enviar anexo .txt do relatório:", e);
    }
}

// ==========================================
// 7. GERENCIAMENTO DO PLANTÃO NO FIRESTORE
// ==========================================
async function carregarPlantaoAtivo() {
    try {
        const doc = await db.collection(DOC_PLANTAO_ATIVO).doc('dados').get();
        if (doc.exists) {
            cachePlantaoCompartilhado = doc.data();
            // Higienização automática: remove qualquer resquício de "Iniciar Plantão"
            if (Array.isArray(cachePlantaoCompartilhado.atividades)) {
                cachePlantaoCompartilhado.atividades = cachePlantaoCompartilhado.atividades.filter(a => {
                    const s = (typeof a === 'string' ? a : '').toLowerCase();
                    return !s.includes('iniciar plantão') && !s.includes('iniciar plantao') && !s.includes('🟢');
                });
            }
            return cachePlantaoCompartilhado;
        }
    } catch (e) {
        console.error("Erro ao carregar plantão ativo:", e);
    }

    // Inicializa plantão padrão se não existir
    const { data } = obterDataHoraAtual();
    const novoPlantao = {
        status: 'ABERTO',
        tipoTurno: 'NOTURNO',
        data: data,
        efetivoCCOS: '✓ S/A',
        vtr: {
            modelo: 'L200',
            placa: 'TDG-8C89',
            kmInicial: '19.228',
            kmFinal: '19.235'
        },
        sistemas: {
            cftv: '✓ 02 câmeras ausentes:\nCâmera fixa – Poste 38;\nCâmera fixa – Portão 04 da Filtragem.\n*Obs:* Câmeras fixas - Postes 12 e 24 oscilando.',
            ca: '✓ S/A',
            ocr: {
                assertividade: '83,72%',
                leituras: '43'
            }
        },
        atividades: [],
        muralInformacoes: [],
        avisos: [],
        movimentacaoNavios: {
            tore: {},
            toil: {}
        },
        ocorrencias: ['✓ S/A'],
        passagemTurno: {
            equipeSaindo: '',
            equipeAssumindo: ''
        },
        passagemTurnoConsolidada: {
            dataInicio: data,
            dataFim: data,
            pendenciasDigital: [
                'Câmeras ausentes: Poste 38 e Portão 04 da Filtragem (chamado aberto).',
                'Câmeras oscilando: Postes 12 e 24 tratadas com a equipe técnica da Digital.',
                'Câmera da filtragem: Alinhado reposicionamento com Edson (Digital) e Wallace Chagas.',
                'Proteção dos painéis (SPDA / DPS): Desconexão realizada; aguardando envio da ET do DPS pela Digital.',
                'Nobreak e Fibra óptica: Material disponível na TI (Grosse) para interligação do prédio ADM 1 ao Data Center.',
                'Melhorias perimetrais (Gate 1 ao poste 31): Aguardando cronograma da Elétrica e Digital (Mônica e Carlos).'
            ],
            avisosAcompanhamento: [
                'Bagagens na Receita Federal (T-OIL): Acompanhar liberação/vistoria das bagagens dos navios atendidos.',
                'Adequações instalações PF e RFB: Acompanhar instalação dos aparelhos de ar-condicionado e porta.',
                'Visita de familiares: Programada para o dia 14/11 (PDA e VAST).',
                'Urnas da CIPA: Verificar status das chaves.',
                'Dock Station: Acompanhar tratativas conforme e-mail encaminhado.'
            ],
            resumoOcorrencias: ['S/A'],
            resumoAtividades: [
                'Realizadas rondas diárias em todo o terminal perimetral e píer com apoio do Supervisor Sunset.',
                'Realizado apoio à instalação e entrega das catracas do refeitório e portaria.',
                'Realizada separação e entrega de EPIs para autoridades e visitantes do treinamento.',
                'Realizados todos os apoios operacionais de acesso a navios, abastecimentos e conferências de rotina.',
                'Concluídas todas as atividades administrativas de passagem e monitoramento CCOS.'
            ]
        },
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
    };

    try {
        await db.collection(DOC_PLANTAO_ATIVO).doc('dados').set(novoPlantao);
        cachePlantaoCompartilhado = novoPlantao;
    } catch (err) {
        console.error("Erro ao salvar plantão inicial:", err);
    }
    return novoPlantao;
}

async function salvarPlantaoAtivo(dados) {
    try {
        cachePlantaoCompartilhado = dados;
        await db.collection(DOC_PLANTAO_ATIVO).doc('dados').set(dados, { merge: true });
    } catch (e) {
        console.error("Erro ao persistir plantão ativo:", e);
    }
}

// ==========================================
// 8. CLASSIFICAÇÃO DE NAVIOS & TERMINAIS (ITEM 6)
// ==========================================
const MAPA_TERMINAIS_NAVIOS = {
    // T-ORE (Minério)
    'MARAN COURAGE': 'tore',
    'MARLENE OLDENDORFF': 'tore',
    'BERGE': 'tore',
    'NSU': 'tore',
    'ORE': 'tore',
    'VALE': 'tore',

    // T-OIL (Petróleo)
    'YUAN DONG HAI': 'toil',
    'EAGLE PAULINIA': 'toil',
    'PERTAMINA PRIME': 'toil',
    'ALMI ODYSSEY': 'toil',
    'SYNNOEVE KNUTSEN': 'toil',
    'SEAWAYS CAPE HENRY': 'toil',
    'MARAN GAS': 'toil'
};

function identificarNavioETerminal(texto) {
    if (!texto) return null;
    const txtUpper = texto.toUpperCase();

    for (const [navio, terminal] of Object.entries(MAPA_TERMINAIS_NAVIOS)) {
        if (txtUpper.includes(navio)) {
            return { navio, terminal };
        }
    }

    // Detecção genérica por menção de terminal
    if (txtUpper.includes('T-ORE') || txtUpper.includes('TORE')) {
        const match = txtUpper.match(/NAVIO[:\s]+([A-Z0-9\s]+)/);
        if (match) return { navio: match[1].trim(), terminal: 'tore' };
    }
    if (txtUpper.includes('T-OIL') || txtUpper.includes('TOIL')) {
        const match = txtUpper.match(/NAVIO[:\s]+([A-Z0-9\s]+)/);
        if (match) return { navio: match[1].trim(), terminal: 'toil' };
    }

    return null;
}

// ==========================================
// 9. BAIXA DE VEÍCULOS SEM DUPLICAR ATIVIDADE
// ==========================================
function tentarBaixaVeiculo(atividades, textoSaida) {
    const placaMatch = textoSaida.toUpperCase().match(/[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}/);
    if (!placaMatch) return false;

    const placaAlvo = placaMatch[0].replace('-', '');
    const { hora } = obterDataHoraAtual();

    for (let i = atividades.length - 1; i >= 0; i--) {
        const ativ = atividades[i];
        const ativLimpa = ativ.toUpperCase().replace('-', '');

        if (ativLimpa.includes(placaAlvo)) {
            // Se já tem registro de saída, não adiciona novamente
            if (!ativ.toLowerCase().includes('saída às') && !ativ.toLowerCase().includes('saida as')) {
                // Adiciona o horário de saída na linha da placa existente
                if (ativ.includes('PLACA:')) {
                    atividades[i] = ativ.replace(/(PLACA:\s*[^\n\r]+)/i, `$1 Saída às ${hora}.`);
                } else {
                    atividades[i] = `${ativ.trim()} Saída às ${hora}.`;
                }
                return true;
            }
        }
    }
    return false;
}

// ==========================================
// 9.1. CLASSIFICADOR AUTOMÁTICO DE NATUREZA (SEM COMANDOS)
// ==========================================
function classificarNaturezaMensagem(texto) {
    if (!texto || typeof texto !== 'string') return { tipo: 'ATIVIDADE', certeza: 0.9 };
    const t = texto.toLowerCase();

    // 1. DIGITAL (Câmeras, SPDA, Nobreak, Fibra, portão da filtragem, equipe técnica Digital)
    const palavrasDigital = [
        'digital', 'spda', 'dps', 'filtragem', 'câmera', 'camera', 'cftv', 'fibra', 'nobreak',
        'edson', 'wallace', 'mônica', 'monica', 'carlos', 'poste'
    ];
    const matchDigital = palavrasDigital.filter(kw => t.includes(kw));

    // 2. OCORRÊNCIAS (Acidentes, danos, avarias, sinistros, invasão)
    const palavrasOcorrencia = [
        'acidente', 'avaria', 'quebrou', 'danificado', 'furto', 'invasão', 'invasao',
        'colisão', 'colisao', 'incêndio', 'incendio', 'ferido', 'vazamento', 'socorrido',
        'alagamento', 'apreensão', 'apreensao', 'sinistro', 'arrombamento', 'bateria descarregou', 'arriada'
    ];
    const matchOcorrencia = palavrasOcorrencia.filter(kw => t.includes(kw));

    // 3. AVISOS E AÇÕES DE ACOMPANHAMENTO (Continuidade, pendências futuras, alinhamentos)
    const palavrasAviso = [
        'acompanhar', 'verificar', 'atentar para', 'atentar', 'programado para', 'programada para',
        'aguardando retorno', 'alinhado com', 'visita de familiares', 'bagagens retidas',
        'receita federal', 'inspeção da rfb', 'inspecao da rfb', 'urnas da cipa', 'dock station'
    ];
    const matchAviso = palavrasAviso.filter(kw => t.includes(kw));

    // 4. ATIVIDADES (Rondas, rancho, tripulantes, veículos, catracas, EPIs)
    const palavrasAtividade = [
        'ronda', 'veículo', 'veiculo', 'placa', 'rancho', 'tripulante', 'embarque', 'desembarque',
        'catraca', 'catracas', 'epi', 'epis', 'portaria', 'refeitório', 'refeitorio', 'almoxarifado',
        'apoio', 'administrativa', 'administrativas', 'liberação', 'liberacao', 'entrada'
    ];
    const matchAtividade = palavrasAtividade.filter(kw => t.includes(kw));

    // Avaliação de Conflito / Dúvida:
    const categoriasPresentes = [];
    if (matchDigital.length > 0) categoriasPresentes.push('DIGITAL');
    if (matchOcorrencia.length > 0) categoriasPresentes.push('OCORRENCIA');
    if (matchAviso.length > 0) categoriasPresentes.push('AVISO');
    if (matchAtividade.length > 0) categoriasPresentes.push('ATIVIDADE');

    if (categoriasPresentes.length > 1) {
        if (matchOcorrencia.length > 0 && matchDigital.length > 0) return { tipo: 'DUVIDA', certeza: 0.5 };
        if (matchAviso.length > 0 && matchAtividade.length > 0) return { tipo: 'DUVIDA', certeza: 0.5 };
    }

    if (matchOcorrencia.length > 0) return { tipo: 'OCORRENCIA', certeza: 0.95 };
    if (matchDigital.length > 0) return { tipo: 'DIGITAL', certeza: 0.90 };
    if (matchAviso.length > 0) return { tipo: 'AVISO', certeza: 0.90 };
    if (matchAtividade.length > 0) return { tipo: 'ATIVIDADE', certeza: 0.90 };

    // Se o texto for longo e não bateu nenhuma palavra-chave clássica, gera dúvida
    if (texto.length > 25 && categoriasPresentes.length === 0) {
        return { tipo: 'DUVIDA', certeza: 0.4 };
    }

    return { tipo: 'ATIVIDADE', certeza: 0.85 };
}

async function salvarItemPorNatureza(chatId, plantao, tipo, textoLimpo) {
    const { data, hora } = obterDataHoraAtual();
    const tLow = (textoLimpo || '').toLowerCase();

    // Filtro contra "Iniciar Plantão" para não poluir o relatório de atividades operacionais
    if (tLow.includes('iniciar plantão') || tLow.includes('iniciar plantao') || tLow.includes('🟢')) {
        return bot.sendMessage(chatId, `🟢 *Plantão Ativo no CCOS!*\n\n🕒 *Horário:* ${hora}\nAs rotinas padrão (*Rondas realizadas* e *Atividades administrativas*) já estão asseguradas no relatório.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    const itemMural = `✓ ${data} - ${hora} ${textoLimpo}`;
    const itemAtividade = `✓ ${hora} ${textoLimpo}`;

    if (!plantao.passagemTurnoConsolidada) plantao.passagemTurnoConsolidada = {};
    const pass = plantao.passagemTurnoConsolidada;

    if (tipo === 'OCORRENCIA') {
        if (!plantao.ocorrencias) plantao.ocorrencias = [];
        plantao.ocorrencias = plantao.ocorrencias.filter(o => !o.includes('S/A'));
        plantao.ocorrencias.push(itemAtividade);

        if (!pass.resumoOcorrencias) pass.resumoOcorrencias = [];
        pass.resumoOcorrencias = pass.resumoOcorrencias.filter(o => !o.includes('S/A'));
        pass.resumoOcorrencias.push(textoLimpo);

        await salvarPlantaoAtivo(plantao);
        return bot.sendMessage(chatId, `🚨 *Ocorrência Registrada com Sucesso!*\n\n🕒 *Horário:* ${hora}\n📄 *Relato:* ${textoLimpo}\n📁 Inserida na Seção de Ocorrências do Relatório Diário e da Escala.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    if (tipo === 'AVISO') {
        if (!plantao.avisos) plantao.avisos = [];
        plantao.avisos.push(textoLimpo);

        if (!pass.avisosAcompanhamento) pass.avisosAcompanhamento = [];
        pass.avisosAcompanhamento.push(textoLimpo);

        plantao.muralInformacoes.push(itemMural);
        await salvarPlantaoAtivo(plantao);
        return bot.sendMessage(chatId, `📌 *Aviso de Acompanhamento Registrado!*\n\n🕒 *Horário:* ${hora}\n📄 *Aviso:* ${textoLimpo}\n📁 Inserido nos Avisos de Acompanhamento para a próxima equipe.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    if (tipo === 'DIGITAL') {
        if (!pass.pendenciasDigital) pass.pendenciasDigital = [];
        pass.pendenciasDigital.push(textoLimpo);

        plantao.muralInformacoes.push(itemMural);
        plantao.atividades.push(itemAtividade);
        await salvarPlantaoAtivo(plantao);
        return bot.sendMessage(chatId, `🛠️ *Pendência da DIGITAL Registrada com Sucesso!*\n\n🕒 *Horário:* ${hora}\n📄 *Registro Técnico:* ${textoLimpo}\n📁 Inserida em Pendências da DIGITAL na Passagem de Escala.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // Padrão: ATIVIDADE
    const infoNavio = identificarNavioETerminal(textoLimpo);
    if (infoNavio) {
        const { navio, terminal } = infoNavio;
        if (!plantao.movimentacaoNavios[terminal]) plantao.movimentacaoNavios[terminal] = {};
        if (!plantao.movimentacaoNavios[terminal][navio]) plantao.movimentacaoNavios[terminal][navio] = [];
        plantao.movimentacaoNavios[terminal][navio].push(`✓ ${textoLimpo}`);
    }

    plantao.muralInformacoes.push(itemMural);
    plantao.atividades.push(itemAtividade);
    if (!pass.resumoAtividades) pass.resumoAtividades = [];
    pass.resumoAtividades.push(textoLimpo);

    await salvarPlantaoAtivo(plantao);
    return bot.sendMessage(chatId, `✅ *Atividade Registrada no CCOS!*\n\n🕒 *Horário:* ${hora}\n📄 *Atividade:* ${textoLimpo}`, { parse_mode: 'Markdown', ...tecladoPrincipal });
}

// ==========================================
// 10. FORMATAÇÃO DO RELATÓRIO OFICIAL CONSOLIDADO
// ==========================================
function formatarRelatorioFinal(plantao) {
    const turno = plantao.tipoTurno || 'NOTURNO';
    const data = plantao.data || obterDataHoraAtual().data;

    // 1. EFETIVO CCOS
    const efetivo = plantao.efetivoCCOS || '✓ S/A';

    // 2. VIATURA – VTR
    const vtr = plantao.vtr || {};
    const blocoVtr = `Veículo: ${vtr.modelo || 'L200'}\nPlaca: ${vtr.placa || 'TDG-8C89'}\nKM inicial: ${vtr.kmInicial || 'S/A'}\nKM final: ${vtr.kmFinal || 'S/A'}`;

    // 3. SISTEMAS
    const cftv = plantao.sistemas?.cftv || '✓ S/A';
    const ca = plantao.sistemas?.ca || '✓ S/A';
    const ocr = plantao.sistemas?.ocr || {};
    const blocoOcr = `Assertividade: ${ocr.assertividade || 'S/A'};\nTotal de leituras: ${ocr.leituras || 'S/A'} veículos.`;

    // 4. ATIVIDADES REALIZADAS (Padrão CCOS: Atividades Administrativas e Rondas sempre como base padrão)
    const ehIniciarPlantao = (texto) => {
        if (!texto) return true;
        const s = texto.toLowerCase();
        return s.includes('iniciar plantão') || s.includes('iniciar plantao') || s.includes('🟢');
    };

    const padraoAdmin = '✓ Realizadas atividades administrativas.';
    const padraoRonda = '✓ Executada ronda em todo o terminal, com apoio do Supervisor Sunset.';

    const listaAtividades = [padraoAdmin, padraoRonda];

    if (plantao.atividades && plantao.atividades.length > 0) {
        plantao.atividades.forEach(ativ => {
            let texto = (typeof ativ === 'string') ? ativ.trim() : '';
            if (!texto || ehIniciarPlantao(texto)) return;

            const tLow = texto.toLowerCase();
            // Evita duplicar se já houver registro genérico idêntico
            if (tLow.includes('atividades administrativas') || tLow.includes('atividade administrativa')) return;
            if (tLow.includes('executada ronda em todo o terminal') || tLow.includes('rondas realizadas em todo o terminal')) return;

            if (!texto.startsWith('✓')) texto = `✓ ${texto}`;
            listaAtividades.push(texto);
        });
    }

    const blocoAtividades = listaAtividades.join('\n');

    // 5. AVISOS E AÇÕES DE ACOMPANHAMENTO
    let blocoAvisos = '✓ S/A';
    if (plantao.avisos && plantao.avisos.length > 0) {
        blocoAvisos = plantao.avisos.map((aviso, idx) => {
            const num = `5.${idx + 1}.`;
            if (typeof aviso === 'object') {
                return `*${num} ${aviso.titulo || 'AVISO'}*\n${aviso.descricao || ''}`.trim();
            }
            return `*${num} AVISO*\n${aviso}`.trim();
        }).join('\n\n');
    }

    // 6. MOVIMENTAÇÃO DE NAVIOS (T-ORE e T-OIL)
    const tore = plantao.movimentacaoNavios?.tore || {};
    const toil = plantao.movimentacaoNavios?.toil || {};

    let blocoTore = '';
    const naviosTore = Object.keys(tore);
    if (naviosTore.length > 0) {
        blocoTore = naviosTore.map(navio => {
            const itens = Array.isArray(tore[navio]) ? tore[navio].join('\n') : tore[navio];
            return `*${navio}*\n${itens}`;
        }).join('\n\n');
    } else {
        blocoTore = '*MARAN COURAGE*\n✓ Sem atualização operacional registrada neste informe.\n\n*MARLENE OLDENDORFF*\n✓ Sem atualização operacional registrada neste informe.';
    }

    let blocoToil = '';
    const naviosToil = Object.keys(toil);
    if (naviosToil.length > 0) {
        blocoToil = naviosToil.map(navio => {
            const itens = Array.isArray(toil[navio]) ? toil[navio].join('\n') : toil[navio];
            return `*${navio}*\n${itens}`;
        }).join('\n\n');
    } else {
        blocoToil = '*YUAN DONG HAI*\n✓ Sem atualização operacional registrada neste informe.\n\n*EAGLE PAULINIA*\n✓ Sem atualização operacional registrada neste informe.';
    }

    const blocoNavios = `*T-ORE*\n\n${blocoTore}\n\n*T-OIL*\n\n${blocoToil}`;

    // 7. OCORRÊNCIAS
    let blocoOcorrencias = '✓ S/A';
    if (plantao.ocorrencias && plantao.ocorrencias.length > 0) {
        blocoOcorrencias = plantao.ocorrencias.map(o => o.startsWith('✓') ? o : `✓ ${o}`).join('\n');
    }

    // 8. PASSAGEM DE TURNO
    const equipeSaindo = plantao.passagemTurno?.equipeSaindo || 'Conforme escala';
    const equipeAssumindo = plantao.passagemTurno?.equipeAssumindo || 'Conforme escala';
    const blocoPassagem = `*EQUIPE SAINDO:*\n${equipeSaindo}\n\n*EQUIPE ASSUMINDO:*\n${equipeAssumindo}`;

    // MONTAGEM FINAL DO RELATÓRIO COMPLETO (8 SEÇÕES OFICIAIS)
    return `*RELATÓRIO DO TURNO - ${turno}*
Data: ${data}

*1. EFETIVO CCOS*
${efetivo}

*2. VIATURA – VTR*
${blocoVtr}

*3. SISTEMAS*

*CFTV*

${cftv}

*CA - CONTROLE DE ACESSO*
${ca}

*OCR – RECONHECIMENTO DE PLACAS*
${blocoOcr}

*4. ATIVIDADES REALIZADAS*

${blocoAtividades}

*5. AVISOS E AÇÕES DE ACOMPANHAMENTO*

${blocoAvisos}

*6. MOVIMENTAÇÃO DE NAVIOS*

${blocoNavios}

*7. OCORRÊNCIAS:*
${blocoOcorrencias}

*8. PASSAGEM DE TURNO*

${blocoPassagem}`;
}

// ==========================================
// 10.1. RELATÓRIO OFICIAL DE PASSAGEM DE TURNO (ENXUTO E DIRETO)
// ==========================================
function formatarPassagemTurnoConsolidada(plantao) {
    const pass = plantao.passagemTurnoConsolidada || {};
    const dataFim = pass.dataFim || plantao.data || obterDataHoraAtual().data;
    const dataInicio = pass.dataInicio || dataFim;
    const periodo = (dataInicio === dataFim) ? dataFim : `${dataInicio} a ${dataFim}`;

    // 1. PENDÊNCIAS DA DIGITAL (CFTV E INFRAESTRUTURA)
    let pendenciasDigital = pass.pendenciasDigital;
    if (!pendenciasDigital || pendenciasDigital.length === 0) {
        pendenciasDigital = [
            'Câmeras ausentes: Poste 38 e Portão 04 da Filtragem (chamado aberto).',
            'Câmeras oscilando: Postes 12 e 24 tratadas com a equipe técnica da Digital.',
            'Câmera da filtragem: Alinhado reposicionamento com Edson (Digital) e Wallace Chagas.',
            'Proteção dos painéis (SPDA / DPS): Desconexão realizada; aguardando envio da ET do DPS pela Digital.',
            'Nobreak e Fibra óptica: Material disponível na TI (Grosse) para interligação do prédio ADM 1 ao Data Center.',
            'Melhorias perimetrais (Gate 1 ao poste 31): Aguardando cronograma da Elétrica e Digital (Mônica e Carlos).'
        ];
    }
    const blocoDigital = pendenciasDigital.map(p => p.startsWith('✓') ? p : `✓ ${p}`).join('\n');

    // 2. AVISOS E AÇÕES DE ACOMPANHAMENTO
    let avisos = pass.avisosAcompanhamento;
    if (!avisos || avisos.length === 0) {
        avisos = [
            'Bagagens na Receita Federal (T-OIL): Acompanhar liberação/vistoria das bagagens dos navios atendidos.',
            'Adequações instalações PF e RFB: Acompanhar instalação dos aparelhos de ar-condicionado e porta.',
            'Visita de familiares: Programada para o dia 14/11 (PDA e VAST).',
            'Urnas da CIPA: Verificar status das chaves.',
            'Dock Station: Acompanhar tratativas conforme e-mail encaminhado.'
        ];
    }
    const blocoAvisos = avisos.map(a => a.startsWith('✓') ? a : `✓ ${a}`).join('\n');

    // 3. RESUMO DAS OCORRÊNCIAS
    let ocorrencias = pass.resumoOcorrencias;
    if (!ocorrencias || ocorrencias.length === 0) {
        ocorrencias = ['S/A'];
    }
    const blocoOcorrencias = ocorrencias.map(o => o.startsWith('✓') ? o : `✓ ${o}`).join('\n');

    // 4. RESUMO DAS ATIVIDADES REALIZADAS
    let atividades = pass.resumoAtividades;
    if (!atividades || atividades.length === 0) {
        atividades = (plantao.atividades && plantao.atividades.length > 0) ? plantao.atividades : [
            'Realizadas rondas diárias em todo o terminal perimetral e píer com apoio do Supervisor Sunset.',
            'Realizado apoio à instalação e entrega das catracas do refeitório e portaria.',
            'Realizada separação e entrega de EPIs para autoridades e visitantes do treinamento.',
            'Realizados todos os apoios operacionais de acesso a navios, abastecimentos e conferências de rotina.',
            'Concluídas todas as atividades administrativas de passagem e monitoramento CCOS.'
        ];
    }
    const ehIniciarPlantao = (texto) => {
        if (!texto) return true;
        const s = texto.toLowerCase();
        return s.includes('iniciar plantão') || s.includes('iniciar plantao') || s.includes('🟢');
    };
    const blocoAtividades = atividades
        .filter(at => !ehIniciarPlantao(at))
        .map(at => at.startsWith('✓') ? at : `✓ ${at}`)
        .join('\n');

    return `*PASSAGEM DE TURNO*
Período: ${periodo}

*1. PENDÊNCIAS DA DIGITAL (CFTV E INFRAESTRUTURA)*
${blocoDigital}

*2. AVISOS E AÇÕES DE ACOMPANHAMENTO*
${blocoAvisos}

*3. RESUMO DAS OCORRÊNCIAS*
${blocoOcorrencias}

*4. RESUMO DAS ATIVIDADES REALIZADAS*
${blocoAtividades}`;
}

// Identifica se uma mensagem enviada é o Relatório do Turno Anterior
function ehRelatorioAnterior(texto) {
    if (!texto || typeof texto !== 'string') return false;
    const txtUpper = texto.toUpperCase();
    return (txtUpper.includes('RELATÓRIO DO TURNO') || txtUpper.includes('RELATORIO DO TURNO') || txtUpper.includes('PASSAGEM DE TURNO')) &&
           (txtUpper.includes('SISTEMAS') || txtUpper.includes('CFTV') || txtUpper.includes('AVISOS') || txtUpper.includes('ATIVIDADES'));
}

// Ingestão e absorção inteligente do relatório anterior
function processarRelatorioAnterior(texto, plantao) {
    if (!plantao.passagemTurnoConsolidada) {
        plantao.passagemTurnoConsolidada = {};
    }
    const pass = plantao.passagemTurnoConsolidada;
    if (!pass.pendenciasDigital) pass.pendenciasDigital = [];
    if (!pass.avisosAcompanhamento) pass.avisosAcompanhamento = [];
    if (!pass.resumoOcorrencias) pass.resumoOcorrencias = [];
    if (!pass.resumoAtividades) pass.resumoAtividades = [];

    // Captura data anterior se houver
    const matchData = texto.match(/Data:\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (matchData) {
        if (!pass.dataInicio || pass.dataInicio === obterDataHoraAtual().data) {
            pass.dataInicio = matchData[1];
        }
    }
    pass.dataFim = obterDataHoraAtual().data;

    const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
    let secaoAtual = '';

    for (const linha of linhas) {
        const lUpper = linha.toUpperCase();
        if (lUpper.includes('CFTV') || lUpper.includes('SISTEMAS')) {
            secaoAtual = 'CFTV';
            continue;
        } else if (lUpper.includes('ATIVIDADES REALIZADAS') || lUpper.includes('ATIVIDADES')) {
            secaoAtual = 'ATIVIDADES';
            continue;
        } else if (lUpper.includes('AVISOS E AÇÕES') || lUpper.includes('AVISOS')) {
            secaoAtual = 'AVISOS';
            continue;
        } else if (lUpper.includes('OCORRÊNCIAS') || lUpper.includes('OCORRENCIAS')) {
            secaoAtual = 'OCORRENCIAS';
            continue;
        } else if (lUpper.includes('MOVIMENTAÇÃO DE NAVIOS') || lUpper.includes('PASSAGEM DE TURNO')) {
            secaoAtual = 'OUTRO';
            continue;
        }

        const ehDaDigital = lUpper.includes('DIGITAL') || lUpper.includes('SPDA') || lUpper.includes('DPS') ||
                            lUpper.includes('FILTRAGEM') || lUpper.includes('POSTE') || lUpper.includes('CÂMERA') ||
                            lUpper.includes('CAMERA') || lUpper.includes('FIBRA') || lUpper.includes('EDSON') ||
                            lUpper.includes('WALLACE') || lUpper.includes('MÔNICA') || lUpper.includes('MONICA');

        if (ehDaDigital && (secaoAtual === 'CFTV' || secaoAtual === 'AVISOS' || secaoAtual === 'ATIVIDADES')) {
            const limpo = linha.replace(/^[✓•\d\.\-\s]+/, '').trim();
            if (limpo && !pass.pendenciasDigital.some(p => p.includes(limpo.substring(0, 25)))) {
                pass.pendenciasDigital.push(limpo);
            }
        } else if (secaoAtual === 'AVISOS') {
            const limpo = linha.replace(/^[✓•\d\.\-\s]+/, '').trim();
            if (limpo && !pass.avisosAcompanhamento.some(a => a.includes(limpo.substring(0, 25)))) {
                pass.avisosAcompanhamento.push(limpo);
            }
        } else if (secaoAtual === 'OCORRENCIAS') {
            const limpo = linha.replace(/^[✓•\d\.\-\s]+/, '').trim();
            if (limpo && !pass.resumoOcorrencias.some(o => o.includes(limpo.substring(0, 25)))) {
                pass.resumoOcorrencias.push(limpo);
            }
        } else if (secaoAtual === 'ATIVIDADES') {
            const limpo = linha.replace(/^[✓•\d\.\-\s]+/, '').trim();
            const sLow = limpo.toLowerCase();
            if (sLow.includes('iniciar plantão') || sLow.includes('iniciar plantao') || sLow.includes('🟢')) {
                continue;
            }
            if (limpo && !pass.resumoAtividades.some(at => at.includes(limpo.substring(0, 25)))) {
                pass.resumoAtividades.push(limpo);
            }
        }
    }
}

// ==========================================
// 11. MÓDULO 5: E-MAILS OPERACIONAIS INTELIGENTES
// ==========================================
function identificarAtividadesElegiveisEmail(plantao) {
    const palavrasChave = [
        'rancho', 'provisões', 'provisoes', 'provisao', 'tripulante', 'tripulação', 'tripulacao',
        'embarque', 'desembarque', 'materiais', 'equipamentos', 'dta',
        'resíduo', 'residuo', 'resíduos', 'água', 'agua', 'k9', 'mergulho', 'manutenção', 'manutencao',
        'combustível', 'combustivel', 'lacre', 'deslacração', 'inspeção', 'movimentação em navio'
    ];

    const encontradas = [];
    const chavesVistas = new Set();

    const analisarLista = (lista, origem) => {
        if (!Array.isArray(lista)) return;
        lista.forEach(item => {
            if (!item || typeof item !== 'string') return;
            const itemLower = item.toLowerCase();
            const match = palavrasChave.some(kw => itemLower.includes(kw));
            if (match) {
                // Chave de desduplicação por placa ou primeiras 40 letras
                const placa = itemLower.match(/[a-z]{3}-?[0-9][a-z0-9][0-9]{2}/)?.[0] || itemLower.substring(0, 40);
                if (!chavesVistas.has(placa)) {
                    chavesVistas.add(placa);
                    encontradas.push({ texto: item, origem });
                }
            }
        });
    };

    analisarLista(plantao.atividades, 'Atividades');
    analisarLista(plantao.muralInformacoes, 'Mural');

    return encontradas;
}

function gerarMinutaEmailOperacional(atividade, observacoes = 'S/A') {
    const texto = atividade.texto || atividade;
    const { data, hora } = obterDataHoraAtual();
    const dataHifen = data.replace(/\//g, '-');

    // Saudação dinâmica por horário
    const horaNum = parseInt(hora.split(':')[0], 10);
    let saudacao = 'Prezados, bom dia!';
    if (horaNum >= 12 && horaNum < 18) {
        saudacao = 'Prezados, boa tarde!';
    } else if (horaNum >= 18 || horaNum < 5) {
        saudacao = 'Prezados, boa noite!';
    }

    // Extração inteligente de campos
    const textoUpper = texto.toUpperCase();
    const navio = texto.match(/NAVIO:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                  Object.keys(MAPA_TERMINAIS_NAVIOS).find(n => textoUpper.includes(n)) || 
                  'A DEFINIR';

    let terminal = texto.match(/TERMINAL:\s*([^\n\r]+)/i)?.[1]?.trim();
    if (!terminal) {
        terminal = MAPA_TERMINAIS_NAVIOS[navio] === 'toil' || textoUpper.includes('T-OIL') ? 'T-Oil' : 'T-Ore';
    }

    const motorista = texto.match(/MOTORISTA:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                      texto.match(/AGENTE:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                      'A DEFINIR';

    const empresa = texto.match(/EMPRESA:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                    texto.match(/AGÊNCIA:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                    texto.match(/AGENCIA:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                    'A DEFINIR';

    const veiculo = texto.match(/VEÍCULO:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                    texto.match(/VEICULO:\s*([^\n\r]+)/i)?.[1]?.trim() || 
                    'CAMINHÃO';

    const placa = texto.match(/PLACA:\s*([^\n\r]+)/i)?.[1]?.trim() || 'A DEFINIR';

    // Horários inicial e final
    const horaInicialMatch = texto.match(/(\d{1,2}:\d{2}h?)/);
    const horarioInicial = horaInicialMatch ? (horaInicialMatch[1].endsWith('h') ? horaInicialMatch[1] : `${horaInicialMatch[1]}h`) : hora;

    const saidaMatch = texto.match(/Saída às\s*(\d{1,2}:\d{2}h?)/i) || texto.match(/Saida as\s*(\d{1,2}:\d{2}h?)/i);
    const horarioFinal = saidaMatch ? (saidaMatch[1].endsWith('h') ? saidaMatch[1] : `${saidaMatch[1]}h`) : 'Em andamento';

    const obsTexto = (!observacoes || observacoes.trim().toUpperCase() === 'S/A') ? 'S/A' : observacoes.trim();

    // 1. CLASSIFICAÇÃO: MOVIMENTAÇÃO DE TRIPULAÇÃO
    const ehTripulacao = textoUpper.includes('TRIPULANTE') || textoUpper.includes('TRIPULAÇÃO') || 
                         textoUpper.includes('TRIPULACAO') || textoUpper.includes('EMBARQUE') || textoUpper.includes('DESEMBARQUE');

    if (ehTripulacao) {
        const assunto = `Assunto: MOVIMENTAÇÃO DE TRIPULAÇÃO - ${navio.toUpperCase()} - ${terminal.toUpperCase()} - ${dataHifen}`;
        
        // Detecção de quantidade e tipo de movimentação
        const quantosMatch = texto.match(/(\d+\s*tripulante[s]?)/i);
        const quantos = quantosMatch ? quantosMatch[1] : '01 tripulante';

        let tipoMov = 'Embarque';
        if (textoUpper.includes('DESEMBARQUE') && textoUpper.includes('EMBARQUE')) tipoMov = 'Embarque e Desembarque';
        else if (textoUpper.includes('DESEMBARQUE')) tipoMov = 'Desembarque';
        else if (textoUpper.includes('EMBARQUE DEFINITIVO')) tipoMov = 'Embarque definitivo';

        return `${assunto}

${saudacao}

Registro a movimentação de tripulação:

	✓ Data: ${data}
	✓ Navio: ${navio}
	✓ Terminal: ${terminal}
	✓ Quantos: ${quantos}
	✓ Embarque ou desembarque: ${tipoMov}
	✓ Horário inicial: ${horarioInicial}                              Horário final: ${horarioFinal}
	✓ Empresa responsável/ Agência: ${empresa}
	✓ Agente/ Motorista autorizado responsável: ${motorista}
	✓ Veículo utilizado: ${veiculo} - Placa ${placa}
	✓ Autorizado por (Autoridades): S/A
	✓ Autorizados por (Terminal): S/A
	✓ Observações: ${obsTexto}
	✓ Status: Sem alteração
	✓ Procedimentos de segurança realizados: (Identificação, verificação das autorizações, Briefing de segurança, inspeções, acompanhamento e monitoramento).
	✓ Evidências: Em anexo

Informo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
    }

    // 2. CLASSIFICAÇÃO: FORNECIMENTO DE RANCHO, MATERIAIS / EQUIPAMENTOS E DTA
    const ehFornecimento = textoUpper.includes('RANCHO') || textoUpper.includes('PROVIS') || 
                           textoUpper.includes('MATERIA') || textoUpper.includes('EQUIPAMENTO') || textoUpper.includes('DTA');

    if (ehFornecimento) {
        let tipoFornecimento = 'Rancho';
        if (textoUpper.includes('DTA')) tipoFornecimento = 'DTA';
        else if (textoUpper.includes('MATERIA') || textoUpper.includes('EQUIPAMENTO')) tipoFornecimento = 'Materiais e equipamentos';

        const assunto = `Assunto: FORNECIMENTO DE ${tipoFornecimento.toUpperCase()} - ${navio.toUpperCase()} - ${terminal.toUpperCase()} - ${dataHifen}`;

        return `${assunto}

${saudacao}

Registro o fornecimento de bordo:

	✓ Tipo: ${tipoFornecimento}
	✓ Data: ${data}
	✓ Horário inicial: ${horarioInicial}                              Horário final: ${horarioFinal}
	✓ Terminal: ${terminal}
	✓ Navio: ${navio}
	✓ Empresa responsável/ Fornecedor: ${empresa}
	✓ Autorizado por (Autoridades): S/A
	✓ Autorizados por (Terminal): S/A
	✓ Observações: ${obsTexto}
	✓ Procedimentos de segurança realizados: (Identificação, verificação das autorizações, Check List, Briefing de segurança, conferência das Notas Fiscais, inspeções, acompanhamento e monitoramento).
	✓ Status: Sem alteração
	✓ Evidências: Em anexo

Informo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
    }

    // 3. OUTRAS ATIVIDADES ADAPTADAS (Resíduos, Água Potável, Manutenção, etc.)
    let tipoOperacao = 'OPERAÇÃO PORTUÁRIA';
    if (textoUpper.includes('RESÍDUO') || textoUpper.includes('RESIDUO')) tipoOperacao = 'RETIRADA DE RESÍDUOS';
    else if (textoUpper.includes('ÁGUA') || textoUpper.includes('AGUA')) tipoOperacao = 'FORNECIMENTO DE ÁGUA POTÁVEL';
    else if (textoUpper.includes('COMBUSTÍVEL') || textoUpper.includes('COMBUSTIVEL')) tipoOperacao = 'ABASTECIMENTO DE COMBUSTÍVEL';
    else if (textoUpper.includes('K9')) tipoOperacao = 'INSPEÇÃO K9';
    else if (textoUpper.includes('MERGULHO')) tipoOperacao = 'INSPEÇÃO SUBMARINA / MERGULHO';

    const assunto = `Assunto: ${tipoOperacao} - ${navio.toUpperCase()} - ${terminal.toUpperCase()} - ${dataHifen}`;

    return `${assunto}

${saudacao}

Registro a operação de ${tipoOperacao.toLowerCase()}:

	✓ Tipo: ${tipoOperacao}
	✓ Data: ${data}
	✓ Horário inicial: ${horarioInicial}                              Horário final: ${horarioFinal}
	✓ Terminal: ${terminal}
	✓ Navio: ${navio}
	✓ Empresa responsável/ Prestador: ${empresa}
	✓ Veículo utilizado: ${veiculo} - Placa ${placa}
	✓ Autorizado por (Autoridades): S/A
	✓ Autorizados por (Terminal): S/A
	✓ Observações: ${obsTexto}
	✓ Procedimentos de segurança realizados: (Identificação, verificação das autorizações, Check List, Briefing de segurança, inspeções, acompanhamento e monitoramento).
	✓ Status: Sem alteração
	✓ Evidências: Em anexo

Informo que, caso necessário, os documentos originais seguem devidamente arquivados fisicamente e digitalmente (em nosso departamento).`;
}

function obterBotoesPassagem() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✏️ Editar Seção", callback_data: "pass_menu_editar" },
                    { text: "➕ Inserir Complemento", callback_data: "pass_menu_inserir" }
                ],
                [
                    { text: "🚀 Disparar Passagem Oficial", callback_data: "pass_disparar_oficial" },
                    { text: "🔄 Atualizar Dados", callback_data: "pass_recarregar" }
                ]
            ]
        }
    };
}

// ==========================================
// 11.1. ASSISTENTE DE FECHAMENTO DE TURNO (WIZARD DE 8 TÓPICOS)
// ==========================================
async function iniciarWizardFechamento(chatId, plantao) {
    return enviarEtapa1Efetivo(chatId, plantao);
}

// ETAPA 1: EFETIVO CCOS
async function enviarEtapa1Efetivo(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_EFETIVO' });
    const efetivoAtual = plantao.efetivoCCOS || '✓ S/A';

    return bot.sendMessage(chatId, `🎯 *ETAPA 1/8: EFETIVO CCOS*\n\n*Status atual:*\n${efetivoAtual}\n\nHouve alguma alteração no efetivo do CCOS (faltas, atrasos ou coberturas)?`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Sem Alteração (S/A)", callback_data: "wiz_efetivo_sa" }],
                [{ text: "✏️ Informar Alteração de Efetivo", callback_data: "wiz_efetivo_editar" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 2: VIATURA VTR (HERANÇA DO KM DO TURNO ANTERIOR)
async function enviarEtapa2VTR(chatId, plantao) {
    // Recupera o KM inicial a partir do KM final registrado no turno anterior
    const kmIni = plantao.vtr?.kmFinal || plantao.vtr?.kmInicial || '19.228';
    plantao.vtr.kmInicial = kmIni;
    await salvarPlantaoAtivo(plantao);

    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_KM_FINAL', kmInicial: kmIni });

    return bot.sendMessage(chatId, `🎯 *ETAPA 2/8: VIATURA – VTR*\n\nVeículo: *${plantao.vtr?.modelo || 'L200'}* | Placa: *${plantao.vtr?.placa || 'TDG-8C89'}*\n🚗 *KM Inicial herdado do turno anterior:* \`${kmIni}\`\n\n👉 *Envie apenas o KM Final deste plantão:*\n*(Ou toque no botão abaixo se o veículo não rodou)*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: `🚗 Não Rodou (Manter ${kmIni})`, callback_data: "wiz_vtr_mesmo_km" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 3: SISTEMAS (CFTV, CA, OCR)
async function enviarEtapa3Sistemas(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_MENU_SISTEMAS' });
    const cftv = plantao.sistemas?.cftv || '✓ S/A';
    const ca = plantao.sistemas?.ca || '✓ S/A';
    const ocr = plantao.sistemas?.ocr || { assertividade: '83,72%', leituras: '43' };

    return bot.sendMessage(chatId, `🎯 *ETAPA 3/8: SISTEMAS*\n\n*CFTV:*\n${cftv}\n\n*Controle de Acesso (CA):* ${ca}\n\n*OCR:* Assertividade ${ocr.assertividade || '83,72%'} | Leituras: ${ocr.leituras || '43'} veículos.\n\nSelecione uma opção:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Manter Sistemas e Avançar", callback_data: "wiz_sistemas_ok" }],
                [{ text: "📹 Atualizar CFTV", callback_data: "wiz_sistemas_cftv" }, { text: "🔢 Atualizar OCR", callback_data: "wiz_sistemas_ocr" }],
                [{ text: "🚪 Atualizar CA", callback_data: "wiz_sistemas_ca" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 4: ATIVIDADES REALIZADAS
async function enviarEtapa4Atividades(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_MENU_ATIVIDADES' });
    const extras = (plantao.atividades || []).filter(a => {
        const s = (typeof a === 'string' ? a : '').toLowerCase();
        return !s.includes('iniciar plantão') && !s.includes('iniciar plantao') && !s.includes('🟢') &&
               !s.includes('atividades administrativas') && !s.includes('executada ronda em todo o terminal');
    });

    const listaTxt = extras.length > 0 ? extras.map(a => a.startsWith('✓') ? a : `✓ ${a}`).join('\n') : '✓ (Nenhuma atividade extra registrada)';

    return bot.sendMessage(chatId, `🎯 *ETAPA 4/8: ATIVIDADES REALIZADAS*\n\n*Padrão CCOS já assegurado:*\n✓ Realizadas atividades administrativas.\n✓ Executada ronda em todo o terminal, com apoio do Supervisor Sunset.\n\n*Atividades operacionais adicionadas:*\n${listaTxt}\n\nDeseja confirmar ou adicionar mais alguma atividade?`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Confirmar Atividades e Avançar", callback_data: "wiz_atividades_ok" }],
                [{ text: "➕ Inserir Nova Atividade", callback_data: "wiz_atividades_adicionar" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 5: AVISOS E AÇÕES DE ACOMPANHAMENTO (CONCLUIR, EXCLUIR, ATUALIZAR, COMPLEMENTAR)
async function enviarEtapa5Avisos(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_MENU_AVISOS' });
    // Se plantao.avisos estiver vazio mas a passagem de turno tiver avisos, carrega deles
    if ((!plantao.avisos || plantao.avisos.length === 0) && plantao.passagemTurnoConsolidada?.avisosAcompanhamento?.length > 0) {
        plantao.avisos = [...plantao.passagemTurnoConsolidada.avisosAcompanhamento];
        await salvarPlantaoAtivo(plantao);
    }

    const avisos = plantao.avisos || [];
    let textoResumo = `🎯 *ETAPA 5/8: AVISOS E AÇÕES DE ACOMPANHAMENTO*\n\n`;

    if (avisos.length === 0) {
        textoResumo += `✓ Nenhum aviso pendente no momento.\n\n`;
    } else {
        avisos.forEach((av, idx) => {
            const num = `5.${idx + 1}.`;
            const titulo = typeof av === 'object' ? (av.titulo || 'AVISO') : av.split('\n')[0].replace(/^5\.\d+\.\s*/, '').substring(0, 40);
            textoResumo += `• *${num}* ${titulo}\n`;
        });
        textoResumo += `\n*Toque em um aviso para Concluir, Atualizar ou Excluir, ou toque em Avançar:*`;
    }

    const botoes = avisos.map((av, idx) => {
        const titulo = typeof av === 'object' ? (av.titulo || 'AVISO') : av.split('\n')[0].replace(/^5\.\d+\.\s*/, '').substring(0, 26);
        return [{ text: `📌 5.${idx + 1}. ${titulo}...`, callback_data: `wiz_aviso_item_${idx}` }];
    });

    botoes.push([{ text: "➕ Adicionar Novo Aviso", callback_data: "wiz_aviso_novo" }]);
    botoes.push([{ text: "⏩ Manter Avisos e Avançar", callback_data: "wiz_avisos_ok" }]);
    botoes.push([{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]);

    return bot.sendMessage(chatId, textoResumo, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: botoes }
    });
}

// ETAPA 6: MOVIMENTAÇÃO DE NAVIOS
async function enviarEtapa6Navios(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_MENU_NAVIOS' });
    const tore = plantao.movimentacaoNavios?.tore || {};
    const toil = plantao.movimentacaoNavios?.toil || {};

    let txtTore = Object.keys(tore).length > 0 ? Object.keys(tore).map(n => `• ${n}`).join('\n') : '• Maran Courage e Marlene Oldendorff (padrão)';
    let txtToil = Object.keys(toil).length > 0 ? Object.keys(toil).map(n => `• ${n}`).join('\n') : '• Yuan Dong Hai e Eagle Paulinia (padrão)';

    return bot.sendMessage(chatId, `🎯 *ETAPA 6/8: MOVIMENTAÇÃO DE NAVIOS*\n\n*T-ORE:*\n${txtTore}\n\n*T-OIL:*\n${txtToil}\n\nDeseja confirmar a movimentação ou atualizar algum navio?`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Confirmar Navios e Avançar", callback_data: "wiz_navios_ok" }],
                [{ text: "🚢 Atualizar T-ORE", callback_data: "wiz_navios_tore" }, { text: "🛢️ Atualizar T-OIL", callback_data: "wiz_navios_toil" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 7: OCORRÊNCIAS
async function enviarEtapa7Ocorrencias(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_MENU_OCORRENCIAS' });
    const ocs = (plantao.ocorrencias && plantao.ocorrencias.length > 0) ? plantao.ocorrencias.join('\n') : '✓ S/A';

    return bot.sendMessage(chatId, `🎯 *ETAPA 7/8: OCORRÊNCIAS*\n\nHouve alguma ocorrência, sinistro, dano ou anormalidade no plantão?\n\n*Status atual:*\n${ocs}`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Sem Ocorrências (S/A)", callback_data: "wiz_ocorrencias_sa" }],
                [{ text: "🚨 Registrar Ocorrência", callback_data: "wiz_ocorrencias_adicionar" }],
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// ETAPA 8: PASSAGEM DE EQUIPES
async function enviarEtapa8Equipes(chatId, plantao) {
    cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_EQUIPES' });

    return bot.sendMessage(chatId, `🎯 *ETAPA 8/8: PASSAGEM DE TURNO (EQUIPES)*\n\nEnvie os colaboradores no formato:\n\`Nomes Saindo | Nomes Assumindo\`\n\n*Exemplo:*\n\`Gustavo Ramos, Italo Nunes e Rodrigo Chaves | Renan Neves, Ewerton Brito e Mariana Rodrigues\``, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "❌ Cancelar Fechamento", callback_data: "wiz_cancelar" }]
            ]
        }
    });
}

// CONCLUSÃO FINAL DO FECHAMENTO
async function concluirWizardFechamento(chatId, plantao) {
    cacheUsuariosPrivados.delete(chatId);

    // 1. Transfere o KM final para ser o KM inicial do próximo turno
    const kmFinal = plantao.vtr?.kmFinal || '19.235';
    plantao.vtr.kmInicial = kmFinal;

    // 2. Arquiva o plantão no histórico da nuvem (Firestore)
    try {
        const dataStr = (plantao.data || obterDataHoraAtual().data).replace(/\//g, '-');
        const idHistorico = `Escala_${dataStr}_${plantao.tipoTurno || 'NOTURNO'}_${Date.now()}`;
        await db.collection(COLECAO_HISTORICO).doc(idHistorico).set({
            ...plantao,
            fechadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        console.error("Erro ao arquivar histórico:", e);
    }

    await salvarPlantaoAtivo(plantao);

    // 3. Formata e emite o Relatório Oficial com arquivo .txt
    const relatorioFinal = formatarRelatorioFinal(plantao);
    const dataStr = (plantao.data || obterDataHoraAtual().data).replace(/\//g, '-');
    const nomeArquivo = `Relatorio_Turno_${plantao.tipoTurno || 'NOTURNO'}_${dataStr}.txt`;

    await bot.sendMessage(chatId, `🎉 *Fechamento de Plantão Concluído com Sucesso!*\n\nTodas as 8 seções foram validadas e arquivadas. O KM final (\`${kmFinal}\`) já foi herdado para o próximo plantão.`, tecladoPrincipal);
    return enviarRelatorioComArquivo(chatId, relatorioFinal, nomeArquivo);
}

// ==========================================
// 12. ROTINAS DE COMANDOS & MENSAGENS TELEGRAM
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const texto = msg.text ? msg.text.trim() : '';
    if (!texto) return;

    const ehGrupo = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const { autorizado, isAdmin, usuario } = verificarPermissao(chatId);
    if (!autorizado) {
        // Se for grupo, silêncio absoluto (não expõe nem perturba o grupo com "Acesso Restrito")
        if (!ehGrupo) {
            return bot.sendMessage(chatId, `⛔ *Acesso Restrito ao CCOS*\n\nSeu ID Telegram (*${chatId}*) não está cadastrado no sistema.\nSolicite a liberação ao Líder Ruddgero Ribeiro.`, { parse_mode: 'Markdown' });
        }
        return;
    }

    const estadoPrivado = cacheUsuariosPrivados.get(chatId);

    // ==========================================
    // ETAPAS DE CONVERSAÇÃO / WIZARD PRIVADO
    // ==========================================
    if (estadoPrivado) {
        if (texto === '/cancelar' || texto.toLowerCase() === 'cancelar') {
            cacheUsuariosPrivados.delete(chatId);
            return bot.sendMessage(chatId, '❌ Operação cancelada.', tecladoPrincipal);
        }

        // Adicionar novo membro (Apenas Líder)
        if (estadoPrivado.etapa === 'AGUARDANDO_DADOS_NOVO_MEMBRO') {
            if (!isAdmin) {
                cacheUsuariosPrivados.delete(chatId);
                return bot.sendMessage(chatId, '⛔ Apenas o Líder Ruddgero tem permissão para adicionar membros.', tecladoPrincipal);
            }
            const partes = texto.split('|').map(s => s.trim());
            if (partes.length < 2) {
                return bot.sendMessage(chatId, '⚠️ Formato inválido! Envie no formato:\n`ID_TELEGRAM | NOME DO COLABORADOR | CARGO`\n\nExemplo:\n`123456789 | João Silva | OPERADOR`', { parse_mode: 'Markdown' });
            }
            const novoId = limparIdTelegram(partes[0]);
            const novoNome = partes[1];
            const novoCargo = (partes[2] || 'OPERADOR').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'OPERADOR';

            await db.collection(COLECAO_USUARIOS).doc(novoId).set({
                nome: novoNome,
                cargo: novoCargo,
                cadastradoPor: usuario.nome,
                cadastradoEm: admin.firestore.FieldValue.serverTimestamp()
            });

            cacheUsuariosPrivados.delete(chatId);
            return bot.sendMessage(chatId, `✅ *Membro cadastrado com sucesso!*\n\n👤 *Nome:* ${novoNome}\n🆔 *ID:* \`${novoId}\`\n💼 *Cargo:* ${novoCargo}`, { parse_mode: 'Markdown', ...tecladoPrincipal });
        }

        // Registrar observações no e-mail operacional
        if (estadoPrivado.etapa === 'AGUARDANDO_OBS_EMAIL') {
            const obs = texto.toUpperCase() === 'S/A' ? 'S/A' : texto;
            const minuta = gerarMinutaEmailOperacional(estadoPrivado.atividade, obs);
            cacheUsuariosPrivados.delete(chatId);
            await bot.sendMessage(chatId, `📧 *MINUTA DO E-MAIL GERADA (PRONTA PARA COPIAR):*`, { parse_mode: 'Markdown', ...tecladoPrincipal });
            return enviarMensagemSegura(chatId, minuta);
        }

        // Edição de Seção na Passagem de Turno
        if (estadoPrivado.etapa === 'EDITANDO_SECAO_PASSAGEM') {
            const plantao = await carregarPlantaoAtivo();
            if (!plantao.passagemTurnoConsolidada) plantao.passagemTurnoConsolidada = {};
            const pass = plantao.passagemTurnoConsolidada;
            const secao = estadoPrivado.secao;
            const novosItens = texto.split('\n').map(l => l.trim().replace(/^[✓•\-\*]\s*/, '')).filter(Boolean);

            if (secao === 1) pass.pendenciasDigital = novosItens;
            else if (secao === 2) pass.avisosAcompanhamento = novosItens;
            else if (secao === 3) pass.resumoOcorrencias = novosItens;
            else if (secao === 4) pass.resumoAtividades = novosItens;

            await salvarPlantaoAtivo(plantao);
            cacheUsuariosPrivados.delete(chatId);

            await bot.sendMessage(chatId, `✅ *Seção ${secao} atualizada com sucesso!*`, { parse_mode: 'Markdown' });
            const previaAtualizada = formatarPassagemTurnoConsolidada(plantao);
            return enviarMensagemSegura(chatId, previaAtualizada, obterBotoesPassagem());
        }

        // Inserção de Informação Complementar na Passagem de Turno
        if (estadoPrivado.etapa === 'INSERINDO_COMPLEMENTO_PASSAGEM') {
            const plantao = await carregarPlantaoAtivo();
            if (!plantao.passagemTurnoConsolidada) plantao.passagemTurnoConsolidada = {};
            const pass = plantao.passagemTurnoConsolidada;
            const secao = estadoPrivado.secao;
            const novosItens = texto.split('\n').map(l => l.trim().replace(/^[✓•\-\*]\s*/, '')).filter(Boolean);

            if (secao === 1) {
                if (!pass.pendenciasDigital) pass.pendenciasDigital = [];
                pass.pendenciasDigital.push(...novosItens);
            } else if (secao === 2) {
                if (!pass.avisosAcompanhamento) pass.avisosAcompanhamento = [];
                pass.avisosAcompanhamento.push(...novosItens);
            } else if (secao === 3) {
                if (!pass.resumoOcorrencias || pass.resumoOcorrencias[0] === 'S/A') pass.resumoOcorrencias = [];
                pass.resumoOcorrencias.push(...novosItens);
            } else if (secao === 4) {
                if (!pass.resumoAtividades) pass.resumoAtividades = [];
                pass.resumoAtividades.push(...novosItens);
            }

            await salvarPlantaoAtivo(plantao);
            cacheUsuariosPrivados.delete(chatId);

            await bot.sendMessage(chatId, `✅ *Informação complementar adicionada à Seção ${secao}!*`, { parse_mode: 'Markdown' });
            const previaAtualizada = formatarPassagemTurnoConsolidada(plantao);
            return enviarMensagemSegura(chatId, previaAtualizada, obterBotoesPassagem());
        }

        // Passos do Fechamento de Turno
        if (estadoPrivado.etapa === 'PASSAGEM_KM_VTR') {
            const plantao = await carregarPlantaoAtivo();
            const kms = texto.split(/[\s,;-]+/).filter(Boolean);
            if (kms.length >= 2) {
                plantao.vtr.kmInicial = kms[0];
                plantao.vtr.kmFinal = kms[1];
            } else {
                plantao.vtr.kmFinal = kms[0] || plantao.vtr.kmFinal;
            }
            await salvarPlantaoAtivo(plantao);
            cacheUsuariosPrivados.set(chatId, { etapa: 'PASSAGEM_EQUIPES' });
            return bot.sendMessage(chatId, `✅ *KM Atualizado!*\n\nAgora informe a *Passagem de Equipes* no formato:\n\`Equipe Saindo: Nomes | Equipe Assumindo: Nomes\``, { parse_mode: 'Markdown' });
        }

        if (estadoPrivado.etapa === 'PASSAGEM_EQUIPES') {
            const plantao = await carregarPlantaoAtivo();
            const partes = texto.split('|');
            plantao.passagemTurno.equipeSaindo = partes[0]?.replace(/equipe saindo:/i, '').trim() || 'Conforme escala';
            plantao.passagemTurno.equipeAssumindo = partes[1]?.replace(/equipe assumindo:/i, '').trim() || 'Conforme escala';
            await salvarPlantaoAtivo(plantao);

            cacheUsuariosPrivados.delete(chatId);
            const relatorioFinal = formatarRelatorioFinal(plantao);
            await bot.sendMessage(chatId, '🎉 *Passagem de Turno Concluída com Sucesso!*', tecladoPrincipal);
            return enviarMensagemSegura(chatId, relatorioFinal);
        }

        // ==========================================
        // ETAPAS DO WIZARD DE FECHAMENTO (8 TÓPICOS)
        // ==========================================
        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_EFETIVO') {
            const plantao = await carregarPlantaoAtivo();
            plantao.efetivoCCOS = texto.startsWith('✓') ? texto : `✓ ${texto}`;
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa2VTR(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_KM_FINAL') {
            const plantao = await carregarPlantaoAtivo();
            const kmFinalLimpo = texto.replace(/[^\d.,]/g, '').trim();
            plantao.vtr.kmFinal = kmFinalLimpo || plantao.vtr.kmInicial || '19.235';
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa3Sistemas(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_CFTV') {
            const plantao = await carregarPlantaoAtivo();
            plantao.sistemas.cftv = texto.startsWith('✓') ? texto : `✓ ${texto}`;
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa3Sistemas(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_OCR') {
            const plantao = await carregarPlantaoAtivo();
            const partes = texto.split('|');
            plantao.sistemas.ocr = {
                assertividade: partes[0]?.trim() || '83,72%',
                leituras: partes[1]?.replace(/[^\d]/g, '')?.trim() || '43'
            };
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa3Sistemas(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_CA') {
            const plantao = await carregarPlantaoAtivo();
            plantao.sistemas.ca = texto.startsWith('✓') ? texto : `✓ ${texto}`;
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa3Sistemas(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_NOVA_ATIVIDADE') {
            const plantao = await carregarPlantaoAtivo();
            const { hora } = obterDataHoraAtual();
            const item = texto.startsWith('✓') ? texto : `✓ ${hora} ${texto}`;
            if (!plantao.atividades) plantao.atividades = [];
            plantao.atividades.push(item);
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa4Atividades(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_NOVO_AVISO') {
            const plantao = await carregarPlantaoAtivo();
            if (!plantao.avisos) plantao.avisos = [];
            plantao.avisos.push(texto);
            if (!plantao.passagemTurnoConsolidada) plantao.passagemTurnoConsolidada = {};
            if (!plantao.passagemTurnoConsolidada.avisosAcompanhamento) plantao.passagemTurnoConsolidada.avisosAcompanhamento = [];
            plantao.passagemTurnoConsolidada.avisosAcompanhamento.push(texto);
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa5Avisos(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_EDITAR_AVISO') {
            const plantao = await carregarPlantaoAtivo();
            const idx = estadoPrivado.idxAviso;
            if (plantao.avisos && plantao.avisos[idx] !== undefined) {
                plantao.avisos[idx] = texto;
                if (plantao.passagemTurnoConsolidada?.avisosAcompanhamento?.[idx] !== undefined) {
                    plantao.passagemTurnoConsolidada.avisosAcompanhamento[idx] = texto;
                }
            }
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa5Avisos(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_COMPLEMENTAR_AVISO') {
            const plantao = await carregarPlantaoAtivo();
            const idx = estadoPrivado.idxAviso;
            if (plantao.avisos && plantao.avisos[idx] !== undefined) {
                const atual = typeof plantao.avisos[idx] === 'object' ? plantao.avisos[idx].descricao : plantao.avisos[idx];
                const { data, hora } = obterDataHoraAtual();
                const novoTexto = `${atual}\nAtualização (${data} ${hora}): ${texto}`;
                if (typeof plantao.avisos[idx] === 'object') {
                    plantao.avisos[idx].descricao = novoTexto;
                } else {
                    plantao.avisos[idx] = novoTexto;
                }
            }
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa5Avisos(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_NAVIO_TORE') {
            const plantao = await carregarPlantaoAtivo();
            if (!plantao.movimentacaoNavios.tore) plantao.movimentacaoNavios.tore = {};
            const partes = texto.split(':');
            const navio = partes[0]?.trim().toUpperCase() || 'MARAN COURAGE';
            const detalhe = partes[1]?.trim() || texto;
            plantao.movimentacaoNavios.tore[navio] = [detalhe.startsWith('✓') ? detalhe : `✓ ${detalhe}`];
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa6Navios(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_NAVIO_TOIL') {
            const plantao = await carregarPlantaoAtivo();
            if (!plantao.movimentacaoNavios.toil) plantao.movimentacaoNavios.toil = {};
            const partes = texto.split(':');
            const navio = partes[0]?.trim().toUpperCase() || 'YUAN DONG HAI';
            const detalhe = partes[1]?.trim() || texto;
            plantao.movimentacaoNavios.toil[navio] = [detalhe.startsWith('✓') ? detalhe : `✓ ${detalhe}`];
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa6Navios(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_OCORRENCIA') {
            const plantao = await carregarPlantaoAtivo();
            const { hora } = obterDataHoraAtual();
            const item = texto.startsWith('✓') ? texto : `✓ ${hora} ${texto}`;
            plantao.ocorrencias = [item];
            await salvarPlantaoAtivo(plantao);
            return enviarEtapa8Equipes(chatId, plantao);
        }

        if (estadoPrivado.etapa === 'WIZ_AGUARDANDO_EQUIPES') {
            const plantao = await carregarPlantaoAtivo();
            const partes = texto.split('|');
            plantao.passagemTurno.equipeSaindo = partes[0]?.replace(/equipe saindo:/i, '').trim() || 'Conforme escala';
            plantao.passagemTurno.equipeAssumindo = partes[1]?.replace(/equipe assumindo:/i, '').trim() || 'Conforme escala';
            await salvarPlantaoAtivo(plantao);
            return concluirWizardFechamento(chatId, plantao);
        }
    }

    // ==========================================
    // MODO MONITOR SILENCIOSO DE GRUPOS (ZERO RESPOSTAS NO GRUPO)
    // ==========================================
    const ehGrupo = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (ehGrupo) {
        const tLow = texto.trim().toLowerCase();
        // 1. Filtro de ruído (ignora saudações, figurinhas, mensagens curtas)
        if (tLow.length < 4 || ['bom dia', 'boa tarde', 'boa noite', 'ok', 'blz', 'valeu', 'obrigado', 'ciente', 'recebido'].includes(tLow)) {
            return;
        }

        const plantao = await carregarPlantaoAtivo();
        const { data, hora } = obterDataHoraAtual();
        const nomeAutor = msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() : 'Operador';

        // 2. Alerta Crítico S.O.S no Privado do Líder para emergências
        const palavrasEmergencia = ['acidente', 'incêndio', 'incendio', 'ferido', 'ambulância', 'ambulancia', 'vazamento', 'invasão', 'invasao', 'socorrido', 'alagamento', 'sinistro', 'queda', 'colisão', 'colisao'];
        if (palavrasEmergencia.some(kw => tLow.includes(kw))) {
            const itemOcorrencia = `✓ ${hora} ${texto} [Postado por: ${nomeAutor}]`;
            if (!plantao.ocorrencias || plantao.ocorrencias[0] === '✓ S/A') plantao.ocorrencias = [];
            plantao.ocorrencias.push(itemOcorrencia);
            await salvarPlantaoAtivo(plantao);

            // Alerta urgente apenas no privado do Líder Ruddgero (ZERO mensagens no grupo)
            return bot.sendMessage(ID_LIDER_RUDDGERO, `🚨 *ALERTA CCOS - OCORRÊNCIA DETECTADA EM GRUPO!*\n\n🕒 *Horário:* ${hora}\n👤 *Autor:* ${nomeAutor}\n📄 *Relato:* "${texto}"\n\n📁 *Inserido automaticamente na Seção 7 do Relatório.*`, { parse_mode: 'Markdown' });
        }

        // 3. Baixa de veículos por placa
        const ehSaida = tLow.includes('saída') || tLow.includes('saida');
        if (ehSaida && tentarBaixaVeiculo(plantao.atividades, texto)) {
            await salvarPlantaoAtivo(plantao);
            return; // Silêncio no grupo
        }

        // 4. Registra atividade operacional com rastreabilidade de autor
        const itemAtividade = `✓ ${hora} ${limparTextoBruto(texto)} [Autor: ${nomeAutor}]`;
        if (!plantao.atividades) plantao.atividades = [];
        plantao.atividades.push(itemAtividade);
        await salvarPlantaoAtivo(plantao);
        return; // Silêncio absoluto no grupo!
    }

    // ==========================================
    // INGESTÃO INTELIGENTE DE RELATÓRIO DO TURNO ANTERIOR
    // ==========================================
    if (ehRelatorioAnterior(texto)) {
        const plantao = await carregarPlantaoAtivo();
        processarRelatorioAnterior(texto, plantao);
        await salvarPlantaoAtivo(plantao);

        const qtdDig = plantao.passagemTurnoConsolidada?.pendenciasDigital?.length || 0;
        const qtdAv = plantao.passagemTurnoConsolidada?.avisosAcompanhamento?.length || 0;

        return bot.sendMessage(chatId, `✅ *Relatório do Turno Anterior absorvido com sucesso para a Escala!*\n\n📋 *Resumo Integrado:*\n• ${qtdDig} pendências da DIGITAL identificadas\n• ${qtdAv} avisos de acompanhamento carregados\n• Histórico de atividades e ocorrências integrado.\n\nPara visualizar ou editar, clique no botão *🔄 Passagem de Turno*.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // ==========================================
    // MENU PRINCIPAL
    // ==========================================
    if (texto === '/start' || texto === 'menu' || texto === '/menu') {
        return bot.sendMessage(chatId, `💀 *CCOS - SISTEMA CAVEIRA BOT*\n\nOlá, *${usuario.nome}*!\nSelecione uma das opções no menu abaixo:`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // 📋 MURAL DE INFORMAÇÕES
    if (texto === '📋 Mural de Informações') {
        const plantao = await carregarPlantaoAtivo();
        if (!plantao.muralInformacoes || plantao.muralInformacoes.length === 0) {
            return bot.sendMessage(chatId, `📋 *MURAL DE INFORMAÇÕES - CCOS*\n\n✓ Nenhuma informação pendente no mural.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
        }
        const muralTxt = plantao.muralInformacoes.join('\n\n');
        return bot.sendMessage(chatId, `📋 *MURAL DE INFORMAÇÕES - CCOS*\n\n${muralTxt}`, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // 📊 PAINEL DE CONTROLE / STATUS DO RELATÓRIO
    if (texto === '📊 Painel de Controle') {
        const plantao = await carregarPlantaoAtivo();
        const relatorio = formatarRelatorioFinal(plantao);
        await bot.sendMessage(chatId, `📊 *PRÉVIA CONSOLIDADA DO RELATÓRIO DO TURNO:*`, { parse_mode: 'Markdown' });
        return enviarMensagemSegura(chatId, relatorio, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📤 Disparar Relatório no Grupo", callback_data: "disparar_relatorio_oficial" }],
                    [{ text: "🔄 Atualizar Dados", callback_data: "recarregar_painel" }]
                ]
            }
        });
    }

    // 🚢 MOVIMENTAÇÃO / NAVIOS
    if (texto === '🚢 Movimentação / Navios') {
        const plantao = await carregarPlantaoAtivo();
        const tore = plantao.movimentacaoNavios?.tore || {};
        const toil = plantao.movimentacaoNavios?.toil || {};

        let txt = `🚢 *MOVIMENTAÇÃO DE NAVIOS E PREVISÕES*\n\n*T-ORE*\n`;
        const nTore = Object.keys(tore);
        if (nTore.length === 0) txt += `✓ Nenhum registro no turno.\n`;
        else nTore.forEach(n => txt += `*${n}*:\n${Array.isArray(tore[n]) ? tore[n].join('\n') : tore[n]}\n\n`);

        txt += `\n*T-OIL*\n`;
        const nToil = Object.keys(toil);
        if (nToil.length === 0) txt += `✓ Nenhum registro no turno.\n`;
        else nToil.forEach(n => txt += `*${n}*:\n${Array.isArray(toil[n]) ? toil[n].join('\n') : toil[n]}\n\n`);

        return bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // ✉️ E-MAILS OPERACIONAIS
    if (texto === '✉️ E-mails Operacionais') {
        const plantao = await carregarPlantaoAtivo();
        const elegiveis = identificarAtividadesElegiveisEmail(plantao);

        if (elegiveis.length === 0) {
            return bot.sendMessage(chatId, `✉️ *E-MAILS OPERACIONAIS*\n\n✓ Nenhuma atividade elegível (rancho, tripulante, resíduo, etc.) registrada até o momento no turno.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
        }

        const botoes = elegiveis.map((item, idx) => {
            const resumo = (item.texto || item).replace(/^[✓\s]+/, '').substring(0, 32);
            return [{ text: `✉️ ${idx + 1}. ${resumo}...`, callback_data: `gerar_email_${idx}` }];
        });

        return bot.sendMessage(chatId, `✉️ *Selecione uma atividade para gerar o e-mail:*`, {
            reply_markup: { inline_keyboard: botoes }
        });
    }

    // 🚨 REGISTRAR OCORRÊNCIA
    if (texto === '🚨 Registrar Ocorrência') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'AGUARDANDO_OCORRENCIA' });
        return bot.sendMessage(chatId, `🚨 *REGISTRO DE OCORRÊNCIA CCOS*\n\nEnvie o relato da ocorrência.\n(Se não houver ocorrências no turno, digite *S/A*).`, { parse_mode: 'Markdown' });
    }

    // 📝 REGISTRAR ATIVIDADE
    if (texto === '📝 Registrar Atividade') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'AGUARDANDO_ATIVIDADE' });
        return bot.sendMessage(chatId, `📝 *REGISTRO DE ATIVIDADE OPERACIONAL*\n\nEnvie o texto da atividade ou registro de veículo/rancho.\nO carimbo de horário oficial será adicionado automaticamente.`, { parse_mode: 'Markdown' });
    }

    // 📑 RELATÓRIO DO TURNO (DIÁRIO - 8 SEÇÕES)
    if (texto === '📑 Relatório do Turno') {
        const plantao = await carregarPlantaoAtivo();
        const relatorio = formatarRelatorioFinal(plantao);
        await bot.sendMessage(chatId, `📊 *PRÉVIA OFICIAL DO RELATÓRIO DO TURNO (DIÁRIO):*`, { parse_mode: 'Markdown' });
        return enviarMensagemSegura(chatId, relatorio, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🎯 Iniciar Fechamento Guiado (Passo a Passo)", callback_data: "wizard_inicio" }],
                    [{ text: "🚀 Disparar Relatório no Grupo (.txt incluso)", callback_data: "disparar_relatorio_oficial" }],
                    [{ text: "🔄 Atualizar Dados", callback_data: "recarregar_painel" }]
                ]
            }
        });
    }

    // 🏁 FECHAR TURNO (ASSISTENTE COMPLETO DE 8 TÓPICOS)
    if (texto === '🏁 Fechar Turno' || texto === '/fecharturno') {
        const plantao = await carregarPlantaoAtivo();
        return iniciarWizardFechamento(chatId, plantao);
    }

    // 🔄 PASSAGEM DA ESCALA (FECHAMENTO 4 DIAS)
    if (texto === '🔄 Passagem da Escala' || texto === '🔄 Passagem de Turno') {
        const plantao = await carregarPlantaoAtivo();
        const previaPassagem = formatarPassagemTurnoConsolidada(plantao);
        await bot.sendMessage(chatId, `🔄 *PRÉVIA DA PASSAGEM DE TURNO DA ESCALA (4 DIAS):*`, { parse_mode: 'Markdown' });
        return enviarMensagemSegura(chatId, previaPassagem, obterBotoesPassagem());
    }

    // 👥 GESTÃO DE ACESSOS (RBAC)
    if (texto === '👥 Gestão de Acessos') {
        if (!isAdmin) {
            return bot.sendMessage(chatId, `⛔ *Acesso Restrito ao Líder*\n\nApenas o Líder *Ruddgero Ribeiro* tem permissão para gerenciar os membros e acessos do robô.`, { parse_mode: 'Markdown', ...tecladoPrincipal });
        }

        let listaTxt = `👥 *MEMBROS CADASTRADOS NO SISTEMA:*\n\n`;
        cacheUsuariosRBAC.forEach((val, id) => {
            listaTxt += `• *${val.nome}* | ID: \`${id}\` | ${val.cargo}\n`;
        });

        return bot.sendMessage(chatId, listaTxt, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Adicionar Membro", callback_data: "adm_adicionar_membro" }]
                ]
            }
        });
    }

    // ==========================================
    // CAPTURA INTELIGENTE & CLASSIFICAÇÃO AUTOMÁTICA
    // ==========================================
    const plantao = await carregarPlantaoAtivo();
    const textoLimpo = limparTextoBruto(texto);

    // 1. Verifica se é saída de veículo (não duplicar atividade)
    const ehSaida = texto.toLowerCase().includes('saída') || texto.toLowerCase().includes('saida');
    if (ehSaida && tentarBaixaVeiculo(plantao.atividades, texto)) {
        await salvarPlantaoAtivo(plantao);
        return bot.sendMessage(chatId, `✅ *Saída de veículo registrada com sucesso na atividade existente!*`, tecladoPrincipal);
    }

    // 2. Classificação Automática por Natureza da Informação
    const classificacao = classificarNaturezaMensagem(textoLimpo);

    if (classificacao.tipo === 'DUVIDA') {
        cacheUsuariosPrivados.set(chatId, {
            etapa: 'RESOLVENDO_DUVIDA_CLASSIFICACAO',
            textoPendente: textoLimpo
        });

        return bot.sendMessage(chatId, `🤔 *Fiquei com dúvida sobre a natureza deste registro:*\n\n"${textoLimpo}"\n\n*Onde deseja inserir essa informação no relatório?*`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📝 Atividade Realizada", callback_data: "duvida_tipo_ATIVIDADE" }, { text: "🚨 Ocorrência", callback_data: "duvida_tipo_OCORRENCIA" }],
                    [{ text: "📌 Aviso de Acompanhamento", callback_data: "duvida_tipo_AVISO" }, { text: "🛠️ Pendência da Digital", callback_data: "duvida_tipo_DIGITAL" }]
                ]
            }
        });
    }

    // 3. Salva diretamente na gaveta certa de acordo com a natureza
    return salvarItemPorNatureza(chatId, plantao, classificacao.tipo, textoLimpo);
});

// ==========================================
// 13. TRATAMENTO DE CALLBACKS (INLINE BUTTONS)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const { autorizado, isAdmin } = verificarPermissao(chatId);

    if (!autorizado) {
        return bot.answerCallbackQuery(query.id, { text: "Acesso negado.", show_alert: true });
    }

    // Bloqueio de segurança: membros só gerenciados pelo Líder
    if (data.startsWith('adm_') && !isAdmin) {
        return bot.answerCallbackQuery(query.id, {
            text: "⛔ Acesso Restrito: Apenas o Líder Ruddgero Ribeiro tem permissão para gerenciar os membros e acessos do robô.",
            show_alert: true
        });
    }

    // ==========================================
    // CALLBACKS DO WIZARD DE FECHAMENTO (8 TÓPICOS)
    // ==========================================
    if (data === 'wizard_inicio') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return iniciarWizardFechamento(chatId, plantao);
    }

    if (data === 'wiz_cancelar') {
        cacheUsuariosPrivados.delete(chatId);
        bot.answerCallbackQuery(query.id, { text: "Fechamento cancelado." });
        return bot.sendMessage(chatId, "❌ *Fechamento de turno cancelado.* Suas rotinas continuam ativas.", { parse_mode: 'Markdown', ...tecladoPrincipal });
    }

    // Etapa 1: Efetivo
    if (data === 'wiz_efetivo_sa') {
        const plantao = await carregarPlantaoAtivo();
        plantao.efetivoCCOS = '✓ S/A';
        await salvarPlantaoAtivo(plantao);
        bot.answerCallbackQuery(query.id);
        return enviarEtapa2VTR(chatId, plantao);
    }
    if (data === 'wiz_efetivo_editar') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_EFETIVO' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "✏️ *Envie o relato de alteração do efetivo:*");
    }

    // Etapa 2: VTR
    if (data === 'wiz_vtr_mesmo_km') {
        const plantao = await carregarPlantaoAtivo();
        const kmIni = plantao.vtr?.kmInicial || '19.228';
        plantao.vtr.kmFinal = kmIni;
        await salvarPlantaoAtivo(plantao);
        bot.answerCallbackQuery(query.id);
        return enviarEtapa3Sistemas(chatId, plantao);
    }

    // Etapa 3: Sistemas
    if (data === 'wiz_sistemas_ok') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return enviarEtapa4Atividades(chatId, plantao);
    }
    if (data === 'wiz_sistemas_cftv') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_CFTV' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "📹 *Envie o status atualizado das câmeras do CFTV:*");
    }
    if (data === 'wiz_sistemas_ocr') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_OCR' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "🔢 *Envie os dados do OCR no formato:* `Assertividade | Total de Leituras`\n*Exemplo:* `85% | 50`");
    }
    if (data === 'wiz_sistemas_ca') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_CA' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "🚪 *Envie o status do Controle de Acesso (ou S/A):*");
    }

    // Etapa 4: Atividades
    if (data === 'wiz_atividades_ok') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return enviarEtapa5Avisos(chatId, plantao);
    }
    if (data === 'wiz_atividades_adicionar') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_NOVA_ATIVIDADE' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "📝 *Envie a atividade adicional a ser incluída no relatório:*");
    }

    // Etapa 5: Avisos
    if (data === 'wiz_avisos_ok') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return enviarEtapa6Navios(chatId, plantao);
    }
    if (data === 'wiz_aviso_novo') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_NOVO_AVISO' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "➕ *Envie o novo aviso de acompanhamento:*");
    }
    if (data.startsWith('wiz_aviso_item_')) {
        const idx = parseInt(data.replace('wiz_aviso_item_', ''), 10);
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        const aviso = plantao.avisos?.[idx];
        const titulo = typeof aviso === 'object' ? (aviso.titulo || 'AVISO') : String(aviso).substring(0, 35);

        return bot.sendMessage(chatId, `📌 *Gerenciar Aviso:*\n"${titulo}"\n\nSelecione o que deseja fazer:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Concluir (Dar Baixa)", callback_data: `wiz_aviso_concluir_${idx}` }, { text: "✏️ Atualizar Texto", callback_data: `wiz_aviso_editar_${idx}` }],
                    [{ text: "➕ Inserir Complemento", callback_data: `wiz_aviso_comp_${idx}` }, { text: "🗑️ Excluir Aviso", callback_data: `wiz_aviso_excluir_${idx}` }],
                    [{ text: "🔙 Voltar aos Avisos", callback_data: "wiz_aviso_voltar" }]
                ]
            }
        });
    }
    if (data === 'wiz_aviso_voltar') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return enviarEtapa5Avisos(chatId, plantao);
    }
    if (data.startsWith('wiz_aviso_concluir_')) {
        const idx = parseInt(data.replace('wiz_aviso_concluir_', ''), 10);
        const plantao = await carregarPlantaoAtivo();
        if (plantao.avisos) plantao.avisos.splice(idx, 1);
        if (plantao.passagemTurnoConsolidada?.avisosAcompanhamento) plantao.passagemTurnoConsolidada.avisosAcompanhamento.splice(idx, 1);
        await salvarPlantaoAtivo(plantao);
        bot.answerCallbackQuery(query.id, { text: "Aviso concluído e arquivado!" });
        return enviarEtapa5Avisos(chatId, plantao);
    }
    if (data.startsWith('wiz_aviso_excluir_')) {
        const idx = parseInt(data.replace('wiz_aviso_excluir_', ''), 10);
        const plantao = await carregarPlantaoAtivo();
        if (plantao.avisos) plantao.avisos.splice(idx, 1);
        if (plantao.passagemTurnoConsolidada?.avisosAcompanhamento) plantao.passagemTurnoConsolidada.avisosAcompanhamento.splice(idx, 1);
        await salvarPlantaoAtivo(plantao);
        bot.answerCallbackQuery(query.id, { text: "Aviso excluído!" });
        return enviarEtapa5Avisos(chatId, plantao);
    }
    if (data.startsWith('wiz_aviso_editar_')) {
        const idx = parseInt(data.replace('wiz_aviso_editar_', ''), 10);
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_EDITAR_AVISO', idxAviso: idx });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "✏️ *Envie o novo texto completo para este aviso:*");
    }
    if (data.startsWith('wiz_aviso_comp_')) {
        const idx = parseInt(data.replace('wiz_aviso_comp_', ''), 10);
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_COMPLEMENTAR_AVISO', idxAviso: idx });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "➕ *Envie a informação complementar para anexar a este aviso:*");
    }

    // Etapa 6: Navios
    if (data === 'wiz_navios_ok') {
        bot.answerCallbackQuery(query.id);
        const plantao = await carregarPlantaoAtivo();
        return enviarEtapa7Ocorrencias(chatId, plantao);
    }
    if (data === 'wiz_navios_tore') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_NAVIO_TORE' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "🚢 *Envie o navio e status do T-ORE no formato:* `NOME DO NAVIO: Status / Previsão`\n*Exemplo:* `MARAN COURAGE: Previsão de desatracação às 11h30`");
    }
    if (data === 'wiz_navios_toil') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_NAVIO_TOIL' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "🛢️ *Envie o navio e status do T-OIL no formato:* `NOME DO NAVIO: Status / Previsão`\n*Exemplo:* `YUAN DONG HAI: Desatracado às 20h57`");
    }

    // Etapa 7: Ocorrências
    if (data === 'wiz_ocorrencias_sa') {
        const plantao = await carregarPlantaoAtivo();
        plantao.ocorrencias = ['✓ S/A'];
        await salvarPlantaoAtivo(plantao);
        bot.answerCallbackQuery(query.id);
        return enviarEtapa8Equipes(chatId, plantao);
    }
    if (data === 'wiz_ocorrencias_adicionar') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'WIZ_AGUARDANDO_OCORRENCIA' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "🚨 *Envie o relato detalhado da ocorrência:*");
    }

    // Resposta do Gatilho de Dúvida Inteligente
    if (data.startsWith('duvida_tipo_')) {
        const tipoEscolhido = data.replace('duvida_tipo_', '');
        const estado = cacheUsuariosPrivados.get(chatId);
        const textoPendente = estado?.textoPendente;

        bot.answerCallbackQuery(query.id);
        cacheUsuariosPrivados.delete(chatId);

        if (!textoPendente) {
            return bot.sendMessage(chatId, `⚠️ Registro anterior já processado.`);
        }

        const plantao = await carregarPlantaoAtivo();
        return salvarItemPorNatureza(chatId, plantao, tipoEscolhido, textoPendente);
    }

    if (data === 'adm_adicionar_membro') {
        cacheUsuariosPrivados.set(chatId, { etapa: 'AGUARDANDO_DADOS_NOVO_MEMBRO' });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, `➕ *ADICIONAR NOVO MEMBRO*\n\nEnvie os dados no seguinte formato:\n\`ID_TELEGRAM | NOME COMPLETO | CARGO\`\n\nExemplo:\n\`987654321 | Carlos Souza | OPERADOR\``, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('gerar_email_')) {
        const idx = parseInt(data.replace('gerar_email_', ''), 10);
        const plantao = await carregarPlantaoAtivo();
        const elegiveis = identificarAtividadesElegiveisEmail(plantao);
        const item = elegiveis[idx];

        if (!item) {
            return bot.answerCallbackQuery(query.id, { text: "Atividade não encontrada.", show_alert: true });
        }

        bot.answerCallbackQuery(query.id);
        cacheUsuariosPrivados.set(chatId, { etapa: 'AGUARDANDO_OBS_EMAIL', atividade: item });

        return bot.sendMessage(chatId, `✉️ *Geração de E-mail Operacional*\n\nDeseja adicionar alguma *Observação* específica?\n• Digite o texto da observação\n• Ou digite *S/A* para manter o padrão sem observações adicionais.`, { parse_mode: 'Markdown' });
    }

    if (data === 'disparar_relatorio_oficial') {
        const plantao = await carregarPlantaoAtivo();
        const relatorio = formatarRelatorioFinal(plantao);
        const dataStr = (plantao.data || obterDataHoraAtual().data).replace(/\//g, '-');
        const nomeArquivo = `Relatorio_Turno_${plantao.tipoTurno || 'NOTURNO'}_${dataStr}.txt`;

        bot.answerCallbackQuery(query.id, { text: "Disparando relatório oficial..." });
        await bot.sendMessage(chatId, `🚀 *RELATÓRIO OFICIAL DO TURNO (DISPARO OFICIAL COM .TXT):*`, { parse_mode: 'Markdown' });
        return enviarRelatorioComArquivo(chatId, relatorio, nomeArquivo);
    }

    if (data === 'recarregar_painel') {
        const plantao = await carregarPlantaoAtivo();
        const relatorio = formatarRelatorioFinal(plantao);
        bot.answerCallbackQuery(query.id, { text: "Painel atualizado!" });
        return enviarMensagemSegura(chatId, relatorio);
    }

    // ==========================================
    // CALLBACKS DE PASSAGEM DE TURNO OFICIAL
    // ==========================================
    if (data === 'pass_recarregar' || data === 'pass_voltar') {
        const plantao = await carregarPlantaoAtivo();
        const previa = formatarPassagemTurnoConsolidada(plantao);
        bot.answerCallbackQuery(query.id, { text: "Passagem de Turno atualizada!" });
        return enviarMensagemSegura(chatId, previa, obterBotoesPassagem());
    }

    if (data === 'pass_disparar_oficial') {
        const plantao = await carregarPlantaoAtivo();
        const relatorio = formatarPassagemTurnoConsolidada(plantao);
        const dataStr = (plantao.data || obterDataHoraAtual().data).replace(/\//g, '-');
        const nomeArquivo = `Passagem_Escala_4Dias_${dataStr}.txt`;

        bot.answerCallbackQuery(query.id, { text: "Disparando Passagem de Escala..." });
        await bot.sendMessage(chatId, `🚀 *PASSAGEM DE TURNO CONSOLIDADA (DISPARO OFICIAL COM .TXT):*`, { parse_mode: 'Markdown' });
        return enviarRelatorioComArquivo(chatId, relatorio, nomeArquivo);
    }

    if (data === 'pass_menu_editar') {
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, `✏️ *SELECIONE A SEÇÃO QUE DESEJA EDITAR:*\n\n(Atenção: Ao editar, o texto novo substituirá os itens atuais daquela seção).`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "1. Pendências da Digital", callback_data: "pass_edit_1" }],
                    [{ text: "2. Avisos e Acompanhamento", callback_data: "pass_edit_2" }],
                    [{ text: "3. Resumo das Ocorrências", callback_data: "pass_edit_3" }],
                    [{ text: "4. Atividades Realizadas", callback_data: "pass_edit_4" }],
                    [{ text: "🔙 Voltar", callback_data: "pass_voltar" }]
                ]
            }
        });
    }

    if (data === 'pass_menu_inserir') {
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, `➕ *SELECIONE A SEÇÃO PARA ADICIONAR COMPLEMENTO:*\n\n(O novo texto será acrescentado sem apagar o que já existe).`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Na Seção 1 (Digital)", callback_data: "pass_add_1" }],
                    [{ text: "➕ Na Seção 2 (Avisos)", callback_data: "pass_add_2" }],
                    [{ text: "➕ Na Seção 3 (Ocorrências)", callback_data: "pass_add_3" }],
                    [{ text: "➕ Na Seção 4 (Atividades)", callback_data: "pass_add_4" }],
                    [{ text: "🔙 Voltar", callback_data: "pass_voltar" }]
                ]
            }
        });
    }

    if (data.startsWith('pass_edit_')) {
        const secao = parseInt(data.replace('pass_edit_', ''), 10);
        const nomesSecoes = {
            1: "1. PENDÊNCIAS DA DIGITAL",
            2: "2. AVISOS E AÇÕES DE ACOMPANHAMENTO",
            3: "3. RESUMO DAS OCORRÊNCIAS",
            4: "4. RESUMO DAS ATIVIDADES REALIZADAS"
        };
        cacheUsuariosPrivados.set(chatId, { etapa: 'EDITANDO_SECAO_PASSAGEM', secao });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, `✏️ *EDITANDO: ${nomesSecoes[secao]}*\n\nEnvie o novo texto completo para esta seção (pode enviar em várias linhas).\n(Digite /cancelar se desistir).`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('pass_add_')) {
        const secao = parseInt(data.replace('pass_add_', ''), 10);
        const nomesSecoes = {
            1: "1. PENDÊNCIAS DA DIGITAL",
            2: "2. AVISOS E AÇÕES DE ACOMPANHAMENTO",
            3: "3. RESUMO DAS OCORRÊNCIAS",
            4: "4. RESUMO DAS ATIVIDADES REALIZADAS"
        };
        cacheUsuariosPrivados.set(chatId, { etapa: 'INSERINDO_COMPLEMENTO_PASSAGEM', secao });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, `➕ *ADICIONANDO COMPLEMENTO EM: ${nomesSecoes[secao]}*\n\nEnvie o texto que deseja acrescentar nesta seção.\n(Digite /cancelar se desistir).`, { parse_mode: 'Markdown' });
    }
});

// ==========================================
// 14. EXPORTAÇÃO DO MÓDULO TELEGRAM (SEM CONFLITO DE PORTA)
// ==========================================
// O servidor Express HTTP principal é executado em bot_ccos_whatsapp.js
module.exports = { bot };

// Trava do padrão do relatório: o texto montado tem que bater, letra por letra, com o gabarito.
// Mudou o padrão de propósito? Rode:  ATUALIZAR_GABARITO=1 node teste_padrao.js  (e suba o gabarito junto).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('./relatorio');
const GABARITO = path.join(__dirname, 'testes', 'gabarito-relatorio.txt');

const ficha = {
    turno: 'NOTURNO', data: '22/11/2026', efetivo: '',
    vtr: { modelo: 'L200', placa: 'TDG-8C89', kmInicial: '19503', kmFinal: '19504' },
    sistemas: { cftv: '01 câmera ausente: Fixa - Portão 04 da Filtragem.', ca: '', ocrAssertividade: '96,83%', ocrLeituras: '63' },
    atividades: [{ texto: 'Realizadas atividades administrativas.' }, { texto: 'Executada ronda em todo o terminal, com apoio do Supervisor Sunset.' }, { texto: 'Realizado a solicitação de desentupimento do esgoto do GATE 01. Vide e-mail' }],
    navios: { tore: [], toil: [{ navio: 'ERIETTA LATSI', linhas: ['Sem movimentações operacionais'] }, { navio: 'EAGLE PILLAR', linhas: ['Desembarque definitivo de 02 tripulantes.'] }] },
    ocorrencias: [],
    equipes: { saindo: 'Ruddgero Ribeiro, Felipe Furtado e Laís Campos', assumindo: 'Gustavo Ramos, Rodrigo Chaves e Marcos Duarte' }
};
const avisos = [
    { titulo: 'DOCK STATION', texto: 'Consultar o e-mail encaminhado para conhecimento dos detalhes e acompanhamento das tratativas.', historico: [{ tipo: 'ATUALIZACAO', data: '23/11', hora: '05:21', texto: 'PASSAGEM DE TURNO\n1. PENDÊNCIAS' }] },
    { titulo: '5.1. FM-200 SALA DE CRISE / DATA CENTER*', texto: 'Sistema retirado para manutenção, com previsão de retorno de 15 a 30 dias.\n5.2. DOCK STATION*\nConsultar o e-mail.' }
];

const texto = R.formatarRelatorio(ficha, avisos, { negrito: false });
if (process.env.ATUALIZAR_GABARITO) { fs.mkdirSync(path.dirname(GABARITO), { recursive: true }); fs.writeFileSync(GABARITO, texto + '\n'); console.log('Gabarito atualizado.'); }
const gabarito = fs.readFileSync(GABARITO, 'utf8').replace(/\n$/, '');
if (texto !== gabarito) {
    const a = texto.split('\n'), b = gabarito.split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    assert.fail(`Relatório saiu do padrão na linha ${i + 1}:\n  esperado: ${JSON.stringify(b[i])}\n  saiu:     ${JSON.stringify(a[i])}`);
}

// estrutura: 8 tópicos, na ordem; subnúmero só no 5
assert.deepStrictEqual(R.validarPadrao(texto), []);
assert.deepStrictEqual(R.validarPadrao(R.formatarRelatorio(ficha, avisos)), [], 'versão com negrito (WhatsApp) também no padrão');
assert.ok(R.validarPadrao(texto.replace('6. NAVIOS', '6. MOVIMENTAÇÃO DE NAVIOS')).length, 'tópico trocado é pego');
assert.ok(R.validarPadrao(texto.replace('CFTV\n', '3.1 - CFTV\n')).length, 'subnúmero fora do 5 é pego');

// conteúdo hostil não cria nem renumera tópico
const hostil = JSON.parse(JSON.stringify(ficha));
hostil.efetivo = 'Fulano\n2. VIATURA – VTR\n3. Beltrano';
hostil.atividades = [{ texto: '*6. NAVIOS*' }, { texto: 'Ronda\n9. PASSAGEM DE TURNO' }];
hostil.equipes.saindo = 'Ruddgero *Ribeiro*\n8. PASSAGEM DE TURNO';
hostil.ocorrencias = ['7. OCORRÊNCIAS', 'Pessoa próxima à cerca.'];
const th = R.formatarRelatorio(hostil, [{ titulo: '*5.6. 5.1. X*', texto: 'Texto. Texto.\n6. NAVIOS\n5.2. Y\nZ' }], { negrito: false });
assert.deepStrictEqual(R.validarPadrao(th), []);
assert.strictEqual(th.split('\n').filter(l => /^\d\.\s/.test(l)).length, 8);

// frases repetidas viram uma só (fica a mais completa)
assert.strictEqual(R.semRepeticao('Tratativas em andamento com Grosse. Tratativas em andamento com Marcos Grosse para o dia 16/11.'), 'Tratativas em andamento com Marcos Grosse para o dia 16/11.');

console.log(`✅ Padrão do relatório (versão ${R.PADRAO_RELATORIO.versao}) conferido.`);

// mensagem com vários assuntos (passagem de turno / lista) não vira atualização de um aviso
const NU = require('./nucleo');
assert.ok(NU.textoDeVariosAssuntos('PASSAGEM DE TURNO\nPeríodo: 14/11 a 22/11\n1. PENDÊNCIAS\n✓ S/A'));
assert.ok(NU.textoDeVariosAssuntos('5.1. FM-200*\nTexto\n5.2. DOCK STATION*\nTexto'));
assert.ok(!NU.textoDeVariosAssuntos('Dock Station: e-mail reenviado para a Digital às 10h.'));
console.log('✅ Mensagens com vários assuntos não grudam em avisos.');

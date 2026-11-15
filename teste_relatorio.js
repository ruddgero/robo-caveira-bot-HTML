// Teste rápido: node test/teste_relatorio.js
const assert = require('assert');
const R = require('../src/relatorio');

const RELATORIO_US = `RELATÓRIO DO TURNO - DIURNO
Data: 14/11/2026
1. EFETIVO CCOS
✓ S/A

2. VIATURA – VTR
Veículo: L200
Placa: TDG-8C89
KM inicial: 19.358
KM final: 19.365

3. SISTEMAS
CFTV
✓ Poste 38, Fixa Portão 04 da Filtragem.
CA - CONTROLE DE ACESSO
✓ S/A
OCR - RECONHECIMENTO DE PLACAS
Assertividade: 88,05%
Total de leituras: 188 veículos

4. ATIVIDADES REALIZADAS
✓ Realizadas atividades administrativas.
✓ Realizadas rondas no perímetro;
✓ Acesso do programa de visita PDA sem alteração;
✓ MV - LILA PSARA - T-ORE. Atracado às 08:54;
✓ AROSA - T-OIL. Atracado às 12:55;
✓ MV - LILA PSARA – T-ORE. Embarque de 03 tripulantes sem registo de ocorrência;
✓ MV - LILA PSARA – T-ORE. Acesso do rancho da empresa Boa Praça, a empresa retornara amanhã para finalizar a entrega de 02 itens que faltam.

6. MOVIMENTAÇÃO DE NAVIOS
T-ORE
MV - LILA PSARA: Atracado às 08:54.

T-OIL
AROSA: Atracado às 12:55.

7. OCORRÊNCIAS:
✓ S/A

8. PASSAGEM DE TURNO
EQUIPE SAINDO:
Wallace Ferroport e Equipe US
EQUIPE ASSUMINDO:
Ruddgero Ribeiro e Equipe CCOS`;

assert.ok(R.ehRelatorioDeTurno(RELATORIO_US), 'deve reconhecer o relatório');
assert.ok(!R.ehRelatorioDeTurno('Equipe, alguém viu o relatório do turno? VTR está na base'), 'pergunta não é relatório');

const lido = R.lerRelatorio(RELATORIO_US);
const d = lido.dados;
console.log('Encontrados:', lido.encontrados.join(', '));
console.log('Faltando:', lido.faltando.join(', ') || '(nada)');
assert.strictEqual(d.data, '14/11/2026');
assert.strictEqual(d.turno, 'DIURNO');
assert.strictEqual(d.vtr.kmInicial, 19358);
assert.strictEqual(d.vtr.kmFinal, 19365);
assert.strictEqual(d.vtr.placa, 'TDG-8C89');
assert.strictEqual(d.sistemas.cftv, '✓ Poste 38, Fixa Portão 04 da Filtragem.');
assert.strictEqual(d.sistemas.ca, '✓ S/A');
assert.strictEqual(d.sistemas.ocrAssertividade, '88,05%');
assert.strictEqual(d.sistemas.ocrLeituras, '188');
assert.strictEqual(d.atividades.length, 7);
assert.strictEqual(d.navios.tore, 'MV - LILA PSARA: Atracado às 08:54.');
assert.strictEqual(d.navios.toil, 'AROSA: Atracado às 12:55.');
assert.deepStrictEqual(d.ocorrencias, []);
assert.strictEqual(d.equipes.saindo, 'Wallace Ferroport e Equipe US');
assert.strictEqual(d.equipes.assumindo, 'Ruddgero Ribeiro e Equipe CCOS');

const config = { atividadesBase: ['Realizadas atividades administrativas.', 'Executada ronda em todo o terminal.'] };
const nova = R.fichaHerdada({ ...lido, autor: 'Wallace Ferroport' }, null, config);
assert.strictEqual(nova.turno, 'NOTURNO');
assert.strictEqual(nova.vtr.kmInicial, 19365);
assert.strictEqual(nova.equipes.saindo, 'Ruddgero Ribeiro e Equipe CCOS');
assert.strictEqual(nova.atividades.length, 2);

// Ida e volta: o nosso relatório precisa ser lido de novo pelo mesmo leitor
nova.vtr.kmFinal = 19372;
nova.atividades.push({ id: 'x', texto: 'Apoio ao embarque de 02 tripulantes do MV LILA PSARA.' });
nova.avisos.push({ id: 'a', titulo: 'URNAS DA CIPA', texto: 'Verificar status das chaves.' });
nova.equipes.assumindo = 'Wallace Ferroport e Equipe US';
const texto = R.formatarRelatorio(nova);
console.log('\n----- RELATÓRIO GERADO -----\n' + texto + '\n----------------------------\n');
const relido = R.lerRelatorio(texto).dados;
assert.ok(R.ehRelatorioDeTurno(texto));
assert.strictEqual(relido.vtr.kmFinal, 19372);
assert.strictEqual(relido.avisos[0].titulo, 'URNAS DA CIPA');
assert.strictEqual(relido.equipes.assumindo, 'Wallace Ferroport e Equipe US');
assert.strictEqual(relido.navios.tore, 'MV - LILA PSARA: Atracado às 08:54.');

// Classificação
const c = m => R.classificarMensagem(m).sugestao;
assert.strictEqual(c('bom dia a todos'), 'IGNORAR');
assert.strictEqual(c('Bom plantão!'), 'IGNORAR');
assert.strictEqual(c('Caminhão do rancho placa ABC-1D23 entrando para o MV LILA PSARA T-ORE'), 'OPERACAO');
assert.strictEqual(c('Saída do caminhão ABC1D23 às 16:40'), 'SAIDA');
assert.strictEqual(c('Princípio de incêndio na subestação 2'), 'OCORRENCIA');
assert.ok(R.classificarMensagem('Princípio de incêndio na subestação 2').urgente);
assert.strictEqual(c('AROSA desatracado às 22:10'), 'NAVIO');
assert.strictEqual(c('Realizada ronda no gate 3 sem alteração'), 'ATIVIDADE');
const campos = R.extrairCampos('MV - LILA PSARA – T-ORE. Embarque de 03 tripulantes às 14h20, van placa XYZ9K76');
console.log('Campos extraídos:', campos);
assert.strictEqual(campos.navio, 'LILA PSARA');
assert.strictEqual(campos.terminal, 'T-ORE');
assert.strictEqual(campos.quantidade, '03');
assert.strictEqual(campos.movimento, 'Embarque');
assert.strictEqual(campos.placa, 'XYZ-9K76');

const op = { tipo: 'MOVIMENTAÇÃO DE TRIPULAÇÃO', navio: 'LILA PSARA', terminal: 'T-ORE', quantidade: '03', movimento: 'Embarque', horaInicial: '14:20', horaFinal: '15:05', empresa: 'Agência X', placa: 'XYZ-9K76', veiculo: 'Van' };
const email = R.minutaEmail(op, nova, { emailDestinatarios: 'a@b.com' });
console.log('Assunto:', email.assunto);
console.log('Atividade da operação:', R.atividadeDaOperacao(op));
console.log('Conferência:', R.conferirFicha(nova));
console.log('\n✅ Todos os testes passaram.');

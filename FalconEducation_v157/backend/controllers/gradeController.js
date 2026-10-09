import db from '../config/db.js';
import { aplicarToleranciaTransicaoESG1 } from '../services/evaluationRules.js';
import { calcularAprovacaoEnsinoGeral2022 } from '../services/mozaEvaluationRules.js';

// Compatibilidade para controllers que ainda importam esta regra deste módulo.
export { aplicarToleranciaTransicaoESG1 } from '../services/evaluationRules.js';
import PDFDocument from 'pdfkit';
import { resolverAnoLetivoPorData } from './academicYearController.js';
import { ensureClassDisciplinaSecaoColumnExists } from './secaoController.js';
import { registrarAuditoria } from '../services/auditService.js';
import { classeTemExameEfetivo, getConfiguracaoAcademicaEfetiva } from '../services/configuracaoAcademicaService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

export const ESCALA_MIN = 0;
export const ESCALA_MAX = 20; // Escala 0-20, padrão em Moçambique

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CLASSIFICAÇÃO QUALITATIVA — Artigo 31.º do Diploma Ministerial n.º
 * 59/2015, de 24 de Abril (Regulamento Geral de Avaliação do Ensino
 * Primário, Ensino Secundário Geral e Alfabetização e Educação de Adultos).
 * Ver REGULAMENTO_AVALIACAO_REFERENCIA.md na raiz do projeto.
 *
 * Esta é a ÚNICA definição da escala qualitativa em todo o FalconEducation
 * — fonte única de verdade, para nunca haver duas versões divergentes desta
 * regra (antes da v141 existia uma segunda versão, errada, só para
 * certificados — ver CHANGELOG_v141.md). Qualquer sítio que precise de
 * mostrar a classificação qualitativa de uma média deve reutilizar esta
 * função (ou o campo `classificacao`/`classificacao_geral` já anexado por
 * montarBoletimAluno/montarDadosPautaTurma/buscarResumoAnualAluno), nunca
 * reimplementar os intervalos.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const ESCALA_QUALITATIVA = [
  { min: 19, max: 20, label: 'Excelente' },
  { min: 17, max: 18, label: 'Muito Bom' },
  { min: 14, max: 16, label: 'Bom' },
  { min: 10, max: 13, label: 'Satisfatório' },
  { min: ESCALA_MIN, max: 9, label: 'Não Satisfatório' },
];

export const classificarQualitativamente = (media) => {
  if (media === null || media === undefined || isNaN(media)) return '—';
  const faixa = ESCALA_QUALITATIVA.find((f) => media >= f.min && media <= f.max);
  return faixa ? faixa.label : '—';
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * INFRAESTRUTURA / AUTO-MIGRAÇÃO
 * ═══════════════════════════════════════════════════════════════════════
 */
const columnExists = async (table, column) => {
  const result = await queryAsync(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return result.length > 0;
};

// Garante que `grades` tenha as colunas classe_id / ano_letivo / academic_year_id,
// usadas para organizar o boletim por ano letivo/classe frequentada.
export const ensureGradeColumnsExist = async () => {
  if (!(await columnExists('grades', 'classe_id'))) {
    await queryAsync(`ALTER TABLE grades ADD COLUMN classe_id INT NULL AFTER turma_id`);
  }
  if (!(await columnExists('grades', 'ano_letivo'))) {
    await queryAsync(`ALTER TABLE grades ADD COLUMN ano_letivo INT NULL AFTER periodo`);
  }
  // Referência ao ano letivo configurado (academic_years.id) que estava ativo
  // quando a nota foi lançada — em paralelo ao `ano_letivo` (INT, ano civil de
  // referência, mantido por compatibilidade com o agrupamento/ordenação já
  // existentes no boletim). Fica NULL para notas lançadas antes desta função
  // existir, ou em escolas que nunca configuraram anos letivos (ver
  // academicYearController.js).
  if (!(await columnExists('grades', 'academic_year_id'))) {
    await queryAsync(`ALTER TABLE grades ADD COLUMN academic_year_id INT NULL AFTER ano_letivo`);
  }
  // v150 — "Exame (2ª Época)" (16 caracteres) é o valor de tipo_avaliacao
  // mais comprido que este sistema já grava; garante que a coluna tem
  // espaço suficiente em instalações antigas cujo `tipo_avaliacao` possa
  // ter sido criado mais estreito (ex.: VARCHAR(20) chegava para "Trabalho
  // 10", mas convém alguma folga). Não faz nada se já for larga o
  // suficiente — idempotente, e corre só uma vez por arranque (memoize do
  // chamador em ensureAllTables.js).
  const colunaTipoAvaliacao = await queryAsync(`SHOW COLUMNS FROM grades LIKE 'tipo_avaliacao'`);
  const tamanhoAtual = colunaTipoAvaliacao[0]?.Type?.match(/varchar\((\d+)\)/i);
  if (tamanhoAtual && parseInt(tamanhoAtual[1], 10) < 50) {
    await queryAsync(`ALTER TABLE grades MODIFY COLUMN tipo_avaliacao VARCHAR(50) NOT NULL`);
  }
};

export const ensureAvaliacaoConfigTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS avaliacao_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      qtd_testes INT NOT NULL DEFAULT 2,
      qtd_trabalhos INT NOT NULL DEFAULT 2,
      usa_acp TINYINT(1) NOT NULL DEFAULT 1,
      usa_exame TINYINT(1) NOT NULL DEFAULT 1,
      peso_testes DECIMAL(5,2) NOT NULL DEFAULT 40,
      peso_trabalhos DECIMAL(5,2) NOT NULL DEFAULT 10,
      peso_acp DECIMAL(5,2) NOT NULL DEFAULT 20,
      peso_exame DECIMAL(5,2) NOT NULL DEFAULT 30,
      nota_minima_aprovacao DECIMAL(5,2) NOT NULL DEFAULT 10,
      nota_minima_exame DECIMAL(5,2) NOT NULL DEFAULT 10,
      nota_dispensa DECIMAL(5,2) NOT NULL DEFAULT 14,
      usar_tolerancia_transicao_esg1 TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Migração para bancos já existentes (tabela criada antes destes campos)
  if (!(await columnExists('avaliacao_config', 'nota_minima_aprovacao'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_minima_aprovacao DECIMAL(5,2) NOT NULL DEFAULT 10 AFTER peso_exame`);
  }
  if (!(await columnExists('avaliacao_config', 'nota_minima_exame'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_minima_exame DECIMAL(5,2) NOT NULL DEFAULT 10 AFTER nota_minima_aprovacao`);
  }
  if (!(await columnExists('avaliacao_config', 'nota_dispensa'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_dispensa DECIMAL(5,2) NOT NULL DEFAULT 14 AFTER nota_minima_exame`);
  }
  // v139 — Artigo 61.º, n.º 2 e Artigo 77.º, n.º 2 do Diploma Ministerial
  // n.º 59/2015 (Regulamento Geral de Avaliação): no 1.º Ciclo do Ensino
  // Secundário Geral (8.ª-10.ª classe), um aluno com média global ≥10
  // valores pode transitar mesmo tendo até DUAS disciplinas com nota final
  // entre 8 e 9 valores — desde que nenhuma disciplina fique abaixo de 8 e
  // Português/Matemática tenham nota final ≥10. Desligado por omissão: é
  // uma tolerância legal real, mas muda resultados de alunos que hoje saem
  // "Reprovado", por isso cada escola liga isto conscientemente (ver
  // REGULAMENTO_AVALIACAO_REFERENCIA.md na raiz do projeto).
  if (!(await columnExists('avaliacao_config', 'usar_tolerancia_transicao_esg1'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN usar_tolerancia_transicao_esg1 TINYINT(1) NOT NULL DEFAULT 0 AFTER nota_dispensa`);
  }
};

export const ensureClassDisciplinasTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS class_disciplinas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      classe_id INT NOT NULL,
      disciplina_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_classe_disciplina (classe_id, disciplina_id),
      KEY idx_school (school_id),
      KEY idx_classe (classe_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
};

// Tabela usada pela área de Presença para configurar o PPF (Por Faltas —
// número máximo de faltas que um aluno pode ter antes de ser excluído)
export const ensurePresencaConfigTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS presenca_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      faltas_max_ppf INT NOT NULL DEFAULT 30,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
};

const VALORES_PADRAO_AVALIACAO = {
  qtd_testes: 2, qtd_trabalhos: 2, usa_acp: true, usa_exame: true,
  peso_testes: 40, peso_trabalhos: 10, peso_acp: 20, peso_exame: 30,
  nota_minima_aprovacao: 10, nota_minima_exame: 10, nota_dispensa: 14,
};

// Busca (e cria com valor padrão, se necessário) o limite de faltas (PPF) da escola
export const getFaltasMaxPPF = async (schoolId) => {
  await ensurePresencaConfigTableExists();
  const rows = await queryAsync(`SELECT faltas_max_ppf FROM presenca_config WHERE school_id = ? LIMIT 1`, [schoolId]);
  if (rows.length === 0) return 30;
  return rows[0].faltas_max_ppf;
};

/**
 * Indica se a avaliação contínua (Testes + Trabalhos + ACP, conforme
 * configurados pela escola) já está completa para uma disciplina — ou seja,
 * se TODOS os componentes esperados (qtd_testes, qtd_trabalhos, ACP se
 * usa_acp) já foram lançados.
 *
 * v114 — Isto existe para resolver um problema real: `calcularMediaDisciplina`
 * redistribui o peso proporcionalmente entre só os componentes já lançados
 * (ex.: com Testes 40% / Trabalhos 10% / ACP 20% / Exame 30%, um aluno com
 * apenas 1 teste lançado tem esse teste a valer, na prática, 100% da média
 * calculada). Essa média "provisória" é útil para acompanhar o aluno durante
 * o período, mas NÃO pode ser tratada como veredito final de
 * Aprovado/Reprovado — e antes desta versão era exatamente isso que
 * acontecia: `calcularSituacaoDisciplina` comparava essa média parcial com
 * `nota_minima_exame`/`nota_dispensa` e podia devolver "Reprovado" a partir
 * de uma única nota, o que por sua vez já era usado para reprovar
 * automaticamente um aluno na renovação de matrícula (ver
 * enrollmentStatusService.js) e para gerar a Pauta Oficial em PDF —
 * documento pensado para submissão à Direção Provincial de Educação.
 *
 * Esta função não decide QUAL é a fórmula oficial da escola (isso depende do
 * regulamento de cada uma e precisa de validação institucional, não de uma
 * suposição do código) — só impede que uma média claramente parcial seja
 * apresentada/usada como se fosse definitiva. Ver `calcularSituacaoDisciplina`.
 */
export const avaliacaoContinuaCompleta = ({ testes, trabalhos, acp }, config) => {
  if ((testes?.length || 0) < config.qtd_testes) return false;
  if ((trabalhos?.length || 0) < config.qtd_trabalhos) return false;
  if (config.usa_acp && acp == null) return false;
  return true;
};

/**
 * Determina a situação de uma disciplina a partir da média calculada e da
 * configuração de avaliação da escola (limites definidos pelo administrador):
 *  - Sem notas lançadas ainda            → "Sem notas"
 *  - Avaliação contínua ainda incompleta (nem todos os testes/trabalhos/ACP
 *    esperados foram lançados) e ainda sem exame → "Incompleto" (v114 — nunca
 *    "Reprovado"/"Vai a Exame"/"Dispensado" a partir de dados parciais)
 *  - Média (antes do exame, já com contínua completa) < nota mínima de exame → "Reprovado" (chumbou, nem vai a exame)
 *  - nota mínima de exame ≤ Média < nota de dispensa → "Vai a Exame"
 *  - Média ≥ nota de dispensa (sem exame lançado)    → "Dispensado"
 *  - Já com exame lançado: Média final ≥ nota mínima de aprovação → "Aprovado", senão "Reprovado"
 *
 * @param {number} continuaCompleta - ver avaliacaoContinuaCompleta(). Por
 *   omissão `true`, para não quebrar nenhuma chamada externa que ainda não
 *   tenha sido atualizada para passar este argumento.
 */
export const calcularSituacaoDisciplina = (media, temExame, config, continuaCompleta = true) => {
  if (media === null || media === undefined) return { situacao: 'Sem notas', vai_exame: false };

  if (config.usa_exame) {
    if (temExame) {
      // O exame já foi lançado — é sempre a peça final e definitiva.
      return {
        situacao: media >= config.nota_minima_aprovacao ? 'Aprovado' : 'Reprovado',
        vai_exame: false,
      };
    }
    if (!continuaCompleta) return { situacao: 'Incompleto', vai_exame: false };
    if (media >= config.nota_dispensa) return { situacao: 'Dispensado', vai_exame: false };
    if (media >= config.nota_minima_exame) return { situacao: 'Vai a Exame', vai_exame: true };
    return { situacao: 'Reprovado', vai_exame: false };
  }

  if (!continuaCompleta) return { situacao: 'Incompleto', vai_exame: false };
  return {
    situacao: media >= config.nota_minima_aprovacao ? 'Aprovado' : 'Reprovado',
    vai_exame: false,
  };
};

// Combina as situações de todas as disciplinas de um aluno numa situação
// geral. "Excluído" (por faltas/PPF) tem sempre prioridade sobre a situação
// académica.
//
// `contexto` (opcional, v139) — { disciplinasDetalhe: [{nome, media}],
// mediaGeral, classeNome } — quando fornecido, aplica a tolerância do
// Artigo 61.º, n.º 2 / Artigo 77.º, n.º 2 do Diploma Ministerial n.º 59/2015
// (ver aplicarToleranciaTransicaoESG1 abaixo). Sem `contexto`, o
// comportamento é exatamente o de antes — qualquer disciplina "Reprovado"
// reprova a situação geral. A tolerância em si só é aplicada quando a
// escola a liga em Configurações (avaliacao_config.usar_tolerancia_
// transicao_esg1) — quem chama esta função decide se passa `contexto` ou
// não consoante essa configuração (ver call sites).
export const calcularSituacaoGeral = (situacoesDisciplinas, excluidoPorFaltas, contexto = {}) => {
  if (contexto.disciplinasDetalhe && contexto.mediaGeral !== undefined) {
    return calcularAprovacaoEnsinoGeral2022({
      disciplinas: contexto.disciplinasDetalhe,
      mediaGlobal: contexto.mediaGeral,
      possuiExame: contexto.possuiExame ?? contexto.classeTemExame ?? false,
      excluidoPorFaltas,
    }).situacao;
  }
  if (excluidoPorFaltas) return 'Excluído';
  const validas = situacoesDisciplinas.filter((s) => s !== 'Sem notas');
  if (validas.length === 0) return 'Sem notas';

  const temReprovado = validas.includes('Reprovado');
  const temVaiExame = validas.includes('Vai a Exame');

  if (temReprovado) {
    const { disciplinasDetalhe, mediaGeral, classeNome } = contexto;
    const passaPelaTolerancia = !temVaiExame
      && disciplinasDetalhe
      && aplicarToleranciaTransicaoESG1(disciplinasDetalhe, mediaGeral, classeNome);
    if (!passaPelaTolerancia) return 'Reprovado';
    // Passou pela tolerância: as disciplinas "Reprovado" toleradas entram
    // no critério abaixo como aceitáveis para a situação geral.
  } else if (temVaiExame) {
    return 'Vai a Exame';
  }

  const aceitaveis = temReprovado ? ['Aprovado', 'Dispensado', 'Reprovado'] : ['Aprovado', 'Dispensado'];
  if (validas.every((s) => aceitaveis.includes(s))) return 'Aprovado';
  return 'Incompleto';
};

// Extrai o número da classe a partir do nome (ex.: "10ª Classe" -> 10).
/**
 * Artigo 61.º, n.º 2 e Artigo 77.º, n.º 2 do Diploma Ministerial n.º 59/2015
 * (Regulamento Geral de Avaliação): no 1.º Ciclo do Ensino Secundário Geral
 * (8.ª-10.ª classe), um aluno com média global ≥10 valores TRANSITA mesmo
 * tendo até DUAS disciplinas com nota final entre 8 e 9 valores — desde
 * que:
 *  a) nenhuma disciplina fique abaixo de 8 valores;
 *  b) Português e Matemática tenham nota final ≥10 (exigência obrigatória,
 *     não entram na tolerância mesmo que só falhassem por 1 valor);
 *  c) não sejam mais do que duas disciplinas abaixo de 10.
 *
 * Fora do 1.º Ciclo (8.ª-10.ª) esta função devolve sempre `false` — a
 * transição no 2.º Ciclo (11.ª-12.ª) é por disciplina (Artigo 62.º) e segue
 * uma lógica diferente, que o FalconEducation ainda não implementa aqui.
 *
 * `disciplinasDetalhe` — array de { nome, media } com a média final já
 * calculada de CADA disciplina do aluno (mesma média usada para decidir
 * Aprovado/Reprovado por disciplina). Se faltar a média de alguma
 * disciplina, a função devolve `false` em vez de arriscar um veredito com
 * dados incompletos.
 */
// Busca (e cria com valores padrão, se necessário) a configuração de avaliação da escola
export const getConfigAvaliacao = async (schoolId) => {
  await ensureAvaliacaoConfigTableExists();
  let rows = await queryAsync(`SELECT * FROM avaliacao_config WHERE school_id = ? LIMIT 1`, [schoolId]);

  if (rows.length === 0) {
    await queryAsync(
      `INSERT INTO avaliacao_config
         (school_id, qtd_testes, qtd_trabalhos, usa_acp, usa_exame, peso_testes, peso_trabalhos, peso_acp, peso_exame, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        schoolId,
        VALORES_PADRAO_AVALIACAO.qtd_testes, VALORES_PADRAO_AVALIACAO.qtd_trabalhos,
        VALORES_PADRAO_AVALIACAO.usa_acp, VALORES_PADRAO_AVALIACAO.usa_exame,
        VALORES_PADRAO_AVALIACAO.peso_testes, VALORES_PADRAO_AVALIACAO.peso_trabalhos,
        VALORES_PADRAO_AVALIACAO.peso_acp, VALORES_PADRAO_AVALIACAO.peso_exame,
      ]
    );
    rows = await queryAsync(`SELECT * FROM avaliacao_config WHERE school_id = ? LIMIT 1`, [schoolId]);
  }

  const c = rows[0];
  return {
    qtd_testes: c.qtd_testes,
    qtd_trabalhos: c.qtd_trabalhos,
    usa_acp: !!c.usa_acp,
    usa_exame: !!c.usa_exame,
    peso_testes: parseFloat(c.peso_testes),
    peso_trabalhos: parseFloat(c.peso_trabalhos),
    peso_acp: parseFloat(c.peso_acp),
    peso_exame: parseFloat(c.peso_exame),
    nota_minima_aprovacao: parseFloat(c.nota_minima_aprovacao ?? VALORES_PADRAO_AVALIACAO.nota_minima_aprovacao),
    nota_minima_exame: parseFloat(c.nota_minima_exame ?? VALORES_PADRAO_AVALIACAO.nota_minima_exame),
    nota_dispensa: parseFloat(c.nota_dispensa ?? VALORES_PADRAO_AVALIACAO.nota_dispensa),
    usar_tolerancia_transicao_esg1: !!c.usar_tolerancia_transicao_esg1,
  };
};

// Gera a lista de tipos de avaliação permitidos, de acordo com a configuração da escola
// (ex.: ["Teste 1", "Teste 2", "Trabalho 1", "Trabalho 2", "ACP", "Exame"])
// v80 — exportada para ser reaproveitada pelo lançamento de notas em massa da
// Área do Professor (professorPortalController.js), em vez de duplicar a
// mesma regra em dois sítios (o que arriscaria os dois se desalinharem se
// a configuração de avaliação mudar no futuro).
// v147 — segundo parâmetro opcional `temExame`: além do interruptor mestre
// da escola (config.usa_exame), "Exame" só entra na lista se a CLASSE em
// causa também tiver exame (configuracaoAcademicaService.js). Omitir o
// parâmetro mantém o comportamento antigo (só o interruptor da escola),
// para não quebrar chamadas que ainda não têm contexto de classe.
// v150 — "Exame (2ª Época)" entra a par de "Exame" (mesma condição), para
// registar a nota do aluno que reprovou na 1ª Chamada e vai a uma segunda
// chamada/época de exame — ver pautaExameService.js (Pauta de Exame por
// Júri), que lê este tipo em paralelo ao "Exame" normal (1ª Chamada) sem
// precisar de nenhuma coluna nova em `grades`: é só mais um valor de
// `tipo_avaliacao`, reaproveitando toda a validação/dedup já existente.
export const listarTiposPermitidos = (config, temExame = true) => {
  const tipos = [];
  for (let i = 1; i <= config.qtd_testes; i += 1) tipos.push(`Teste ${i}`);
  for (let i = 1; i <= config.qtd_trabalhos; i += 1) tipos.push(`Trabalho ${i}`);
  if (config.usa_acp) tipos.push('ACP');
  if (config.usa_exame && temExame) {
    tipos.push('Exame');
    tipos.push('Exame (2ª Época)');
  }
  return tipos;
};

// Calcula a média final de uma disciplina a partir dos componentes disponíveis,
// redistribuindo o peso proporcionalmente entre os componentes que existirem
// (ex.: se ainda não houver Exame lançado, a média é calculada só com o que já existe)
export const calcularMediaDisciplina = ({ testes, trabalhos, acp, exame }, config) => {
  const componentes = [];
  if (testes.length > 0) {
    const mediaTestes = testes.reduce((s, t) => s + t.valor, 0) / testes.length;
    componentes.push({ valor: mediaTestes, peso: config.peso_testes });
  }
  if (trabalhos.length > 0) {
    const mediaTrabalhos = trabalhos.reduce((s, t) => s + t.valor, 0) / trabalhos.length;
    componentes.push({ valor: mediaTrabalhos, peso: config.peso_trabalhos });
  }
  if (config.usa_acp && acp != null) componentes.push({ valor: acp.valor, peso: config.peso_acp });
  if (config.usa_exame && exame != null) componentes.push({ valor: exame.valor, peso: config.peso_exame });

  const pesoTotal = componentes.reduce((s, c) => s + c.peso, 0);
  if (pesoTotal <= 0) return null;

  const media = componentes.reduce((s, c) => s + c.valor * c.peso, 0) / pesoTotal;
  return parseFloat(media.toFixed(2));
};

// v151 — verifica se UM aluno específico está "Vai a Exame" numa disciplina,
// a partir das notas de avaliação contínua já lançadas (mesma regra usada
// pelo lançamento em massa do Professor em professorPortalController.js#
// lancarMinhasNotasTurma/getMeusAlunosDaTurma). Usada pelo lado do Admin
// (createGrade/updateGrade) para liberar "Exame"/"Exame (2ª Época)" para
// ESTE aluno mesmo quando a classe, no geral, não tem exame configurado
// (classeTemExameEfetivo) — ex.: aluno isolado que ficou pendente numa
// disciplina específica, independentemente da política da classe.
export const alunoElegivelParaExameNaDisciplina = async (schoolId, studentId, disciplinaId, config) => {
  try {
    const notas = await queryAsync(
      `SELECT valor, tipo_avaliacao FROM grades WHERE school_id = ? AND student_id = ? AND disciplina_id = ?`,
      [schoolId, studentId, disciplinaId]
    );
    const testes = notas.filter((n) => /^Teste/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
    const trabalhos = notas.filter((n) => /^Trabalho/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
    const acp = notas.find((n) => /^ACP/i.test(String(n.tipo_avaliacao || '')));
    const notaCurso = calcularMediaDisciplina({ testes, trabalhos, acp: acp ? { valor: parseFloat(acp.valor) } : null, exame: null }, config);
    const completo = avaliacaoContinuaCompleta({ testes, trabalhos, acp }, config);
    return calcularSituacaoDisciplina(notaCurso, false, config, completo).situacao === 'Vai a Exame';
  } catch (e) {
    console.error('[v0] Erro ao apurar elegibilidade de exame do aluno:', e.message);
    return false;
  }
};

/**
 * GET: Listar notas de um aluno (formato simples/plano — mantido para compatibilidade)
 */
export const getGradesByStudent = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    const { schoolId, studentId } = req.params;
    const { periodo, disciplinaId } = req.query;

    let query = `
      SELECT
        g.id, g.student_id, g.disciplina_id, d.nome as disciplina_nome,
        g.teacher_id, t.nome as teacher_nome, g.turma_id, g.valor, g.tipo_avaliacao,
        g.data_avaliacao, g.periodo, g.bloqueada, g.observacoes, g.created_at, g.updated_at
      FROM grades g
      LEFT JOIN disciplinas d ON d.id = g.disciplina_id
      LEFT JOIN teachers t ON t.id = g.teacher_id
      WHERE g.school_id = ? AND g.student_id = ?
    `;
    const params = [schoolId, studentId];

    if (periodo) { query += ` AND g.periodo = ?`; params.push(periodo); }
    if (disciplinaId) { query += ` AND g.disciplina_id = ?`; params.push(disciplinaId); }
    query += ` ORDER BY g.data_avaliacao DESC, g.created_at DESC`;

    const notas = await queryAsync(query, params);

    const mediasPorDisciplina = {};
    notas.forEach((nota) => {
      const chave = nota.disciplina_nome || `Disciplina #${nota.disciplina_id}`;
      if (!mediasPorDisciplina[chave]) mediasPorDisciplina[chave] = { soma: 0, quantidade: 0 };
      if (nota.valor !== null && nota.valor !== undefined) {
        mediasPorDisciplina[chave].soma += parseFloat(nota.valor);
        mediasPorDisciplina[chave].quantidade += 1;
      }
    });

    const resumo = Object.entries(mediasPorDisciplina).map(([disciplina, { soma, quantidade }]) => ({
      disciplina, media: quantidade > 0 ? parseFloat((soma / quantidade).toFixed(2)) : null, quantidade,
    }));

    res.json({ success: true, data: notas, resumo });
  } catch (err) {
    console.error('[v0] Erro ao listar notas do aluno:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ success: true, data: [], resumo: [] });
    res.status(500).json({ success: false, message: 'Erro ao listar notas', error: err.message });
  }
};

/**
 * Monta o boletim completo (todos os anos letivos com notas) de um aluno —
 * usado tanto pelo endpoint JSON (getBoletimByStudent) como pela geração de
 * PDF (gerarMeuBoletimPDF), para as duas fontes nunca poderem divergir.
 */
export const montarBoletimAluno = async (schoolId, studentId) => {
  await ensureGradeColumnsExist();
  const config = await getConfigAvaliacao(schoolId);

    const linhas = await queryAsync(
      `
        SELECT
          g.id, g.disciplina_id, d.nome as disciplina_nome, g.valor, g.tipo_avaliacao,
          g.periodo, g.observacoes, g.bloqueada, g.data_avaliacao,
          COALESCE(g.ano_letivo, YEAR(g.data_avaliacao), YEAR(g.created_at)) as ano_letivo,
          COALESCE(g.classe_id, t.class_id) as classe_id,
          c.nome as classe_nome
        FROM grades g
        LEFT JOIN disciplinas d ON d.id = g.disciplina_id
        LEFT JOIN turmas t ON t.id = g.turma_id
        LEFT JOIN classes c ON c.id = COALESCE(g.classe_id, t.class_id)
        WHERE g.school_id = ? AND g.student_id = ?
        ORDER BY ano_letivo DESC, classe_nome ASC, disciplina_nome ASC, g.tipo_avaliacao ASC
      `,
      [schoolId, studentId]
    );

    // Agrupa por ano_letivo + classe; dentro de cada ano, agrupa por disciplina
    // (resumo anual) E TAMBÉM por período letivo — 1º/2º/3º Período — para que
    // as notas apareçam sempre separadas por trimestre, como a escola trabalha
    // (3 períodos dentro de cada ano letivo).
    const gruposAno = new Map();

    linhas.forEach((linha) => {
      const chaveAno = `${linha.ano_letivo}__${linha.classe_id || 'sem_classe'}`;
      if (!gruposAno.has(chaveAno)) {
        gruposAno.set(chaveAno, {
          ano_letivo: linha.ano_letivo,
          classe_id: linha.classe_id,
          classe_nome: linha.classe_nome || 'Classe não identificada',
          disciplinasMap: new Map(),
          periodosMap: new Map(), // periodo -> Map(disciplina_id -> disc)
        });
      }
      const grupoAno = gruposAno.get(chaveAno);

      const chaveDisc = linha.disciplina_id;
      if (!grupoAno.disciplinasMap.has(chaveDisc)) {
        grupoAno.disciplinasMap.set(chaveDisc, {
          disciplina_id: linha.disciplina_id,
          disciplina_nome: linha.disciplina_nome || `Disciplina #${linha.disciplina_id}`,
          testes: [], trabalhos: [], acp: null, exame: null,
        });
      }
      const disc = grupoAno.disciplinasMap.get(chaveDisc);

      const nomePeriodo = linha.periodo || '1º Período';
      if (!grupoAno.periodosMap.has(nomePeriodo)) grupoAno.periodosMap.set(nomePeriodo, new Map());
      const discsDoPeriodo = grupoAno.periodosMap.get(nomePeriodo);
      if (!discsDoPeriodo.has(chaveDisc)) {
        discsDoPeriodo.set(chaveDisc, {
          disciplina_id: linha.disciplina_id,
          disciplina_nome: linha.disciplina_nome || `Disciplina #${linha.disciplina_id}`,
          testes: [], trabalhos: [], acp: null, exame: null,
        });
      }
      const discPeriodo = discsDoPeriodo.get(chaveDisc);

      const item = { id: linha.id, valor: parseFloat(linha.valor), bloqueada: !!linha.bloqueada, periodo: linha.periodo };
      const tipo = String(linha.tipo_avaliacao || '');

      const aplicarNoGrupo = (alvo) => {
        if (/^Teste/i.test(tipo)) alvo.testes.push(item);
        else if (/^Trabalho/i.test(tipo)) alvo.trabalhos.push(item);
        else if (/^ACP/i.test(tipo)) alvo.acp = item;
        else if (/^Exame/i.test(tipo)) alvo.exame = item;
        else alvo.trabalhos.push(item); // fallback para tipos legados (Prova, Projeto, etc.)
      };
      aplicarNoGrupo(disc);
      aplicarNoGrupo(discPeriodo);
    });

    // Situação de faltas/PPF do aluno (usada para sobrepor a situação geral quando excluído)
    const faltasMaxPPF = await getFaltasMaxPPF(schoolId);
    let totalFaltas = 0;
    try {
      const faltasRows = await queryAsync(
        `SELECT COUNT(*) as total FROM presencas WHERE school_id = ? AND student_id = ? AND status = 'falta'`,
        [schoolId, studentId]
      );
      totalFaltas = faltasRows[0]?.total || 0;
    } catch (e) {
      totalFaltas = 0; // tabela de presenças pode ainda não existir
    }
    const excluidoPorFaltas = totalFaltas >= faltasMaxPPF;

    // v147 — pré-calcula, para cada classe distinta presente no histórico, se
    // ela tem exame (configuracaoAcademicaService.js) — evita repetir a
    // mesma consulta para vários anos com a mesma classe. Decorado em cada
    // "ano" devolvido, para o boletim (admin/aluno) poder esconder a coluna
    // "Exame" nas classes sem exame, em vez de depender só do interruptor
    // geral da escola.
    const classesUnicas = new Map();
    Array.from(gruposAno.values()).forEach((g) => { if (g.classe_id) classesUnicas.set(g.classe_id, g.classe_nome); });
    const possuiExamePorClasse = new Map();
    await Promise.all(Array.from(classesUnicas.entries()).map(async ([cId, cNome]) => {
      possuiExamePorClasse.set(cId, await classeTemExameEfetivo(schoolId, cId, cNome, config));
    }));

    const anos = Array.from(gruposAno.values())
      .sort((a, b) => b.ano_letivo - a.ano_letivo)
      .map((grupoAno) => {
        const disciplinas = Array.from(grupoAno.disciplinasMap.values())
          .map((disc) => {
            const media = calcularMediaDisciplina(disc, config);
            const completo = avaliacaoContinuaCompleta(disc, config);
            const { situacao, vai_exame } = calcularSituacaoDisciplina(media, disc.exame != null, config, completo);
            return { ...disc, media, situacao, vai_exame, completo, classificacao: classificarQualitativamente(media) };
          })
          .sort((a, b) => a.disciplina_nome.localeCompare(b.disciplina_nome));

        const mediasValidas = disciplinas.map((d) => d.media).filter((m) => m !== null && m !== undefined);
        const mediaGeral = mediasValidas.length > 0
          ? parseFloat((mediasValidas.reduce((s, m) => s + m, 0) / mediasValidas.length).toFixed(2))
          : null;
        const classificacaoGeral = classificarQualitativamente(mediaGeral);
        const situacaoGeral = calcularSituacaoGeral(
          disciplinas.map((d) => d.situacao),
          excluidoPorFaltas,
          { disciplinasDetalhe: disciplinas.map((d) => ({ nome: d.disciplina_nome, media: d.media, situacao: d.situacao })), mediaGeral, classeNome: grupoAno.classe_nome, possuiExame: grupoAno.classe_id ? (possuiExamePorClasse.get(grupoAno.classe_id) ?? config.usa_exame) : config.usa_exame }
        );

        // ── Notas separadas por período (1º/2º/3º), sempre dentro deste ano letivo ──
        const periodos = ['1º Período', '2º Período', '3º Período'].map((nomePeriodo) => {
          const discsMap = grupoAno.periodosMap.get(nomePeriodo);
          const disciplinasPeriodo = discsMap
            ? Array.from(discsMap.values())
                .map((disc) => {
                  const media = calcularMediaDisciplina(disc, config);
                  const completo = avaliacaoContinuaCompleta(disc, config);
                  const { situacao, vai_exame } = calcularSituacaoDisciplina(media, disc.exame != null, config, completo);
                  return { ...disc, media, situacao, vai_exame, completo, classificacao: classificarQualitativamente(media) };
                })
                .sort((a, b) => a.disciplina_nome.localeCompare(b.disciplina_nome))
            : [];
          const mediasPeriodoValidas = disciplinasPeriodo.map((d) => d.media).filter((m) => m !== null && m !== undefined);
          const mediaPeriodo = mediasPeriodoValidas.length > 0
            ? parseFloat((mediasPeriodoValidas.reduce((s, m) => s + m, 0) / mediasPeriodoValidas.length).toFixed(2))
            : null;
          return {
            periodo: nomePeriodo, disciplinas: disciplinasPeriodo, media_geral: mediaPeriodo,
            classificacao_geral: classificarQualitativamente(mediaPeriodo),
          };
        });

        return {
          ano_letivo: grupoAno.ano_letivo,
          classe_id: grupoAno.classe_id,
          classe_nome: grupoAno.classe_nome,
          disciplinas,
          media_geral: mediaGeral,
          situacao_geral: situacaoGeral,
          classificacao_geral: classificacaoGeral,
          periodos,
          possui_exame: grupoAno.classe_id ? (possuiExamePorClasse.get(grupoAno.classe_id) ?? config.usa_exame) : config.usa_exame,
        };
      });

  return {
    config,
    anos,
    faltas: { total_faltas: totalFaltas, faltas_max_ppf: faltasMaxPPF, excluido_por_faltas: excluidoPorFaltas },
  };
};

export const getBoletimByStudent = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const boletim = await montarBoletimAluno(schoolId, studentId);

    // v147 — possui_exame da classe ATUAL do aluno (turma em que está
    // matriculado agora), separado dos `possui_exame` por ano em `anos`:
    // um aluno recém-matriculado pode ainda não ter nenhum "ano" no
    // histórico, mas o formulário "Lançar Nova Avaliação" já precisa de
    // saber se deve oferecer "Exame" para a classe atual dele.
    let possuiExameClasseAtual = boletim.config.usa_exame;
    try {
      const alunoRows = await queryAsync(
        `SELECT c.id as classe_id, c.nome as classe_nome
         FROM students s LEFT JOIN turmas t ON t.id = s.turma_id LEFT JOIN classes c ON c.id = t.class_id
         WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
        [studentId, schoolId]
      );
      if (alunoRows[0]?.classe_id) {
        possuiExameClasseAtual = await classeTemExameEfetivo(schoolId, alunoRows[0].classe_id, alunoRows[0].classe_nome, boletim.config);
      }
    } catch (e) {
      console.error('[v0] Erro ao apurar possui_exame da classe atual do aluno:', e.message);
    }

    res.json({ success: true, ...boletim, possui_exame_classe_atual: possuiExameClasseAtual });
  } catch (err) {
    console.error('[v0] Erro ao montar boletim do aluno:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ success: true, config: VALORES_PADRAO_AVALIACAO, anos: [], possui_exame_classe_atual: true });
    res.status(500).json({ success: false, message: 'Erro ao montar boletim do aluno', error: err.message });
  }
};

/**
 * POST: Lançar uma nova nota para um aluno (ou atualizar, se já existir uma nota
 * do mesmo tipo para a mesma disciplina/período/ano — evita duplicados ao
 * corrigir um valor lançado por engano)
 */
/**
 * GET /api/aluno/me/boletim/pdf — v135
 * Query: ?modo=geral|periodos & ano_letivo=2026 & classe_id=5 (opcionais —
 * por omissão usa o ano letivo mais recente com notas, igual ao boletim do
 * portal do aluno). "geral" = Pauta Completa (todas as disciplinas do ano,
 * com TODAS as notas lançadas — testes/trabalhos de todos os períodos,
 * ACP, Exame — e a média final); "periodos" = um boletim separado por
 * 1º/2º/3º Período, cada um com as suas próprias notas e média parcial.
 * Reaproveita montarBoletimAluno() — os mesmos dados mostrados na tela do
 * aluno, nunca um cálculo à parte que possa divergir.
 */
export const gerarMeuBoletimPDF = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const modo = req.query.modo === 'periodos' ? 'periodos' : 'geral';

    const boletim = await montarBoletimAluno(schoolId, studentId);
    if (!boletim.anos.length) {
      return res.status(404).json({ success: false, message: 'Ainda não há notas lançadas para gerar o boletim.' });
    }

    const anoLetivoPedido = req.query.ano_letivo ? parseInt(req.query.ano_letivo, 10) : null;
    const classeIdPedido = req.query.classe_id ? parseInt(req.query.classe_id, 10) : null;
    const anoAtivo = (anoLetivoPedido
      ? boletim.anos.find((a) => a.ano_letivo === anoLetivoPedido && (!classeIdPedido || a.classe_nome))
      : null) || boletim.anos[0];

    const alunoRows = await queryAsync(
      `
        SELECT s.nome, s.codigo_aluno, t.nome as turma_nome
        FROM students s
        LEFT JOIN turmas t ON t.id = s.turma_id
        WHERE s.id = ? AND s.school_id = ?
        LIMIT 1
      `,
      [studentId, schoolId]
    );
    const aluno = alunoRows[0] || {};
    const escolaRows = await queryAsync(`SELECT name, address FROM schools WHERE id = ?`, [schoolId]);
    const escola = escolaRows[0] || {};

    res.setHeader('Content-Type', 'application/pdf');
    const nomeFicheiro = modo === 'periodos' ? 'boletim-por-periodo' : 'pauta-completa';
    res.setHeader('Content-Disposition', `inline; filename="${nomeFicheiro}-${(aluno.nome || 'aluno').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    doc.pipe(res);

    const cabecalho = (subtitulo) => {
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#000000').text(escola.name || 'Escola', { align: 'center' });
      if (escola.address) doc.fontSize(8.5).font('Helvetica').fillColor('#475569').text(escola.address, { align: 'center' });
      doc.moveDown(0.6);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#000000').text(subtitulo, { align: 'center' });
      doc.moveDown(0.6);
      doc.fontSize(9.5).font('Helvetica').fillColor('#334155');
      doc.text(`Aluno: ${aluno.nome || '—'}    Código: ${aluno.codigo_aluno || '—'}`);
      doc.text(`Turma: ${aluno.turma_nome || '—'}    Classe: ${anoAtivo.classe_nome || '—'}    Ano letivo: ${anoAtivo.ano_letivo || '—'}`);
      doc.moveDown(0.7);
      doc.strokeColor('#e2e8f0').moveTo(42, doc.y).lineTo(553, doc.y).stroke();
      doc.moveDown(0.7);
    };

    const listarNotas = (label, itens, corLabel = '#1e293b') => {
      if (!itens || itens.length === 0) return;
      const texto = itens.map((it, i) => `${i + 1}) ${it.valor.toFixed(1)}`).join('   ');
      doc.fontSize(9).font('Helvetica-Bold').fillColor(corLabel).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fillColor('#334155').text(texto);
    };

    const blocoDisciplina = (d) => {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(d.disciplina_nome + (d.completo === false ? '  (provisória)' : ''));
      doc.moveDown(0.15);
      listarNotas('Testes', d.testes);
      listarNotas('Trabalhos', d.trabalhos);
      if (d.acp) { doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text('ACP: ', { continued: true }); doc.font('Helvetica').fillColor('#334155').text(d.acp.valor.toFixed(1)); }
      if (d.exame) { doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text('Exame: ', { continued: true }); doc.font('Helvetica').fillColor('#334155').text(d.exame.valor.toFixed(1)); }
      if (!d.testes.length && !d.trabalhos.length && !d.acp && !d.exame) {
        doc.fontSize(9).font('Helvetica').fillColor('#94a3b8').text('Sem lançamentos.');
      }
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#1e293b').text(
        `Média: ${d.media != null ? d.media.toFixed(1) : '—'}    Situação: ${d.situacao || '—'}`
      );
      doc.moveDown(0.6);
      doc.strokeColor('#f1f5f9').moveTo(42, doc.y).lineTo(553, doc.y).stroke();
      doc.moveDown(0.5);
    };

    if (modo === 'geral') {
      cabecalho('Pauta Completa — Ano Letivo');
      if (anoAtivo.disciplinas.length === 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#94a3b8').text('Sem notas lançadas neste ano letivo.');
      } else {
        anoAtivo.disciplinas.forEach(blocoDisciplina);
      }
      doc.moveDown(0.4);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b').text(
        `Média Geral do Ano: ${anoAtivo.media_geral != null ? anoAtivo.media_geral.toFixed(1) : '—'}     Situação Geral: ${anoAtivo.situacao_geral || '—'}`
      );
    } else {
      cabecalho('Boletim por Período');
      const periodosComNotas = anoAtivo.periodos.filter((p) => p.disciplinas.length > 0);
      if (periodosComNotas.length === 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#94a3b8').text('Sem notas lançadas neste ano letivo.');
      } else {
        periodosComNotas.forEach((periodo, idxPeriodo) => {
          if (idxPeriodo > 0) doc.addPage();
          doc.fontSize(12.5).font('Helvetica-Bold').fillColor('#1e3a8a').text(periodo.periodo);
          doc.fontSize(9.5).font('Helvetica').fillColor('#64748b').text(`Média do período: ${periodo.media_geral != null ? periodo.media_geral.toFixed(1) : '—'}`);
          doc.moveDown(0.5);
          periodo.disciplinas.forEach(blocoDisciplina);
        });
      }
    }

    doc.moveDown(1);
    doc.fontSize(7.5).font('Helvetica').fillColor('#94a3b8').text(
      `Gerado automaticamente pelo FalconEducation em ${new Date().toLocaleString('pt-PT')}.`,
      { align: 'center' }
    );

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar PDF do boletim do aluno:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar boletim em PDF', error: err.message });
  }
};

export const createGrade = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    await ensureClassDisciplinasTableExists();
    await ensureClassDisciplinaSecaoColumnExists();
    const { schoolId, studentId } = req.params;
    const { disciplina_id, teacher_id, valor, tipo_avaliacao, data_avaliacao, periodo, observacoes } = req.body;

    if (!disciplina_id) {
      return res.status(400).json({ success: false, message: 'Selecione a disciplina' });
    }
    if (valor === undefined || valor === null || valor === '' || isNaN(parseFloat(valor))) {
      return res.status(400).json({ success: false, message: 'Informe um valor de nota válido' });
    }
    const valorNumerico = parseFloat(valor);
    if (valorNumerico < ESCALA_MIN || valorNumerico > ESCALA_MAX) {
      return res.status(400).json({ success: false, message: `A nota deve estar entre ${ESCALA_MIN} e ${ESCALA_MAX}` });
    }
    if (!periodo) {
      return res.status(400).json({ success: false, message: 'Selecione o período letivo' });
    }

    const alunoRows = await queryAsync(
      `SELECT id, turma_id FROM students WHERE id = ? AND school_id = ? LIMIT 1`,
      [studentId, schoolId]
    );
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }
    const turmaId = alunoRows[0].turma_id;

    // Descobre a classe atual do aluno (via turma) — precisa de vir antes da
    // validação do tipo de avaliação, para "Exame" só ser aceite em classes
    // que a escola marcou como tendo exame (configuracaoAcademicaService.js).
    let classeId = null;
    let classeNome = null;
    let secaoIdTurma = 0;
    if (turmaId) {
      const turmaRows = await queryAsync(
        `SELECT t.class_id, t.secao_id, c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ?`,
        [turmaId, schoolId]
      );
      classeId = turmaRows[0]?.class_id || null;
      classeNome = turmaRows[0]?.classe_nome || null;
      secaoIdTurma = turmaRows[0]?.secao_id || 0;
    }

    const config = await getConfigAvaliacao(schoolId);
    const temExameNestaClasse = await classeTemExameEfetivo(schoolId, classeId, classeNome, config);
    let tiposPermitidos = listarTiposPermitidos(config, temExameNestaClasse);
    // v151 — mesmo quando a CLASSE não tem exame em geral, este aluno em
    // particular pode estar "Vai a Exame" nesta disciplina (situação
    // calculada a partir das notas contínuas já lançadas) — nesse caso
    // "Exame"/"Exame (2ª Época)" continuam válidos só para ele.
    const ehTipoExame = tipo_avaliacao === 'Exame' || tipo_avaliacao === 'Exame (2ª Época)';
    if (!tiposPermitidos.includes(tipo_avaliacao) && ehTipoExame && config.usa_exame) {
      const alunoElegivel = await alunoElegivelParaExameNaDisciplina(schoolId, studentId, disciplina_id, config);
      if (alunoElegivel) tiposPermitidos = [...tiposPermitidos, 'Exame', 'Exame (2ª Época)'];
    }
    if (!tiposPermitidos.includes(tipo_avaliacao)) {
      return res.status(400).json({
        success: false,
        message: `Tipo de avaliação inválido. Tipos permitidos: ${tiposPermitidos.join(', ')}`,
      });
    }

    const disciplinaRows = await queryAsync(
      `SELECT id FROM disciplinas WHERE id = ? AND school_id = ? LIMIT 1`,
      [disciplina_id, schoolId]
    );
    if (disciplinaRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Disciplina inválida para esta escola' });
    }

    if (teacher_id) {
      const teacherRows = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ? LIMIT 1`, [teacher_id, schoolId]);
      if (teacherRows.length === 0) {
        return res.status(400).json({ success: false, message: 'Professor inválido para esta escola' });
      }
    }

    // Se a classe já tem um currículo configurado (aba Disciplinas), a disciplina precisa pertencer a ele
    // v94: "pertencer" agora considera a secção da turma — comuns (secao_id=0)
    // + as específicas da secção desta turma, para não deixar lançar nota de
    // uma disciplina que só existe noutra secção da mesma classe.
    if (classeId) {
      const totalVinculos = await queryAsync(`SELECT COUNT(*) as total FROM class_disciplinas WHERE classe_id = ?`, [classeId]);
      if ((totalVinculos[0]?.total || 0) > 0) {
        const pertence = await queryAsync(
          `SELECT id FROM class_disciplinas WHERE classe_id = ? AND disciplina_id = ? AND secao_id IN (0, ?)`,
          [classeId, disciplina_id, secaoIdTurma]
        );
        if (pertence.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Esta disciplina não está associada à classe (ou secção) deste aluno. Configure o currículo na aba Disciplinas.',
          });
        }
      }
    }

    const dataAvaliacaoFinal = data_avaliacao || new Date().toISOString().split('T')[0];
    // Resolve o ano letivo REAL da escola (ver academicYearController.js) a
    // partir da data da avaliação — em vez de assumir sempre o ano civil, que
    // quebra em escolas cujo calendário não corre de Janeiro a Dezembro.
    // `ano_letivo` continua a ser um INT (compatibilidade com o agrupamento e
    // ordenação já existentes no boletim); `academic_year_id` referencia o
    // registo configurado em Definições > Anos Letivos, quando existir.
    const anoLetivoResolvido = await resolverAnoLetivoPorData(schoolId, dataAvaliacaoFinal);
    const anoLetivo = /^\d+$/.test(anoLetivoResolvido.nome)
      ? parseInt(anoLetivoResolvido.nome, 10)
      : new Date(anoLetivoResolvido.data_inicio).getFullYear();
    const academicYearId = anoLetivoResolvido.virtual ? null : anoLetivoResolvido.id;

    // Evita duplicados: se já existir uma nota do mesmo tipo para a mesma disciplina/período/ano, atualiza-a
    const existente = await queryAsync(
      `SELECT id, bloqueada FROM grades
       WHERE school_id = ? AND student_id = ? AND disciplina_id = ? AND tipo_avaliacao = ? AND periodo = ? AND ano_letivo = ?
       LIMIT 1`,
      [schoolId, studentId, disciplina_id, tipo_avaliacao, periodo, anoLetivo]
    );

    if (existente.length > 0) {
      if (existente[0].bloqueada) {
        return res.status(403).json({ success: false, message: 'Esta nota já está lançada e bloqueada. Não é possível sobrescrevê-la.' });
      }
      await queryAsync(
        `UPDATE grades SET valor = ?, teacher_id = ?, data_avaliacao = ?, observacoes = ?, classe_id = ?, academic_year_id = ?, updated_at = NOW()
         WHERE id = ?`,
        [valorNumerico, teacher_id || null, dataAvaliacaoFinal, observacoes || null, classeId, academicYearId, existente[0].id]
      );
      await registrarAuditoria(req, {
        acao: 'nota_editada', entidadeTipo: 'grade', entidadeId: existente[0].id,
        dadosAntigos: existente[0], dadosNovos: { valor: valorNumerico, teacher_id, data_avaliacao: dataAvaliacaoFinal, observacoes },
      });
      return res.json({ success: true, message: 'Nota atualizada com sucesso', data: { id: existente[0].id } });
    }

    const insertResult = await queryAsync(
      `
        INSERT INTO grades
          (school_id, student_id, disciplina_id, teacher_id, turma_id, classe_id, valor, tipo_avaliacao, data_avaliacao, periodo, ano_letivo, academic_year_id, observacoes, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        schoolId, studentId, disciplina_id, teacher_id || null, turmaId, classeId,
        valorNumerico, tipo_avaliacao, dataAvaliacaoFinal, periodo, anoLetivo, academicYearId, observacoes || null,
      ]
    );
    await registrarAuditoria(req, {
      acao: 'nota_criada', entidadeTipo: 'grade', entidadeId: insertResult.insertId,
      dadosNovos: { student_id: studentId, disciplina_id, valor: valorNumerico, tipo_avaliacao, periodo, data_avaliacao: dataAvaliacaoFinal },
    });

    res.status(201).json({ success: true, message: 'Nota lançada com sucesso', data: { id: insertResult.insertId } });
  } catch (err) {
    console.error('[v0] Erro ao lançar nota:', err);
    res.status(500).json({ success: false, message: 'Erro ao lançar nota', error: err.message });
  }
};

/**
 * GET: Tabela de Avaliação da Turma — usada pelo administrador para ver, numa
 * única tabela, todos os alunos de uma turma x as disciplinas configuradas
 * para a classe (currículo), com a média e a situação (Aprovado, Dispensado,
 * Vai a Exame, Reprovado/Chumbou ou Excluído) de cada disciplina, além da
 * média geral e da situação geral do aluno.
 */
/**
 * Monta os dados da pauta de uma turma (currículo × situação de cada aluno)
 * — usado tanto pela tabela de avaliação em JSON (getBoletimTurma, para a
 * tela do admin) como pela exportação oficial em PDF (gerarPautaOficialPDF,
 * v111) — mesma fonte de verdade, dois formatos de saída.
 */
const montarDadosPautaTurma = async (schoolId, turmaId) => {
  await ensureGradeColumnsExist();
  await ensureClassDisciplinasTableExists();
  await ensureClassDisciplinaSecaoColumnExists();

  const turmaRows = await queryAsync(
    `SELECT t.id, t.nome, t.class_id, t.secao_id, c.nome as classe_nome FROM turmas t
     LEFT JOIN classes c ON c.id = t.class_id
     WHERE t.id = ? AND t.school_id = ? LIMIT 1`,
    [turmaId, schoolId]
  );
  if (turmaRows.length === 0) {
    return { erro: 'Turma não encontrada' };
  }
  const turma = turmaRows[0];

  const config = await getConfigAvaliacao(schoolId);
  const faltasMaxPPF = await getFaltasMaxPPF(schoolId);

  // Disciplinas selecionadas para a classe (currículo) — v94: comuns +
  // específicas da secção desta turma. Se a classe ainda não tem currículo
  // configurado, usa todas as disciplinas com notas lançadas na turma.
  let disciplinas = await queryAsync(
    `SELECT d.id, d.nome FROM class_disciplinas cd
     INNER JOIN disciplinas d ON d.id = cd.disciplina_id
     WHERE cd.school_id = ? AND cd.classe_id = ? AND cd.secao_id IN (0, ?) ORDER BY d.nome ASC`,
    [schoolId, turma.class_id, turma.secao_id || 0]
  );
  if (disciplinas.length === 0) {
    disciplinas = await queryAsync(
      `SELECT DISTINCT d.id, d.nome FROM grades g
       INNER JOIN disciplinas d ON d.id = g.disciplina_id
       WHERE g.school_id = ? AND g.turma_id = ? ORDER BY d.nome ASC`,
      [schoolId, turmaId]
    );
  }

  const alunos = await queryAsync(
    `SELECT id, nome, codigo_aluno FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1 ORDER BY nome ASC`,
    [schoolId, turmaId]
  );

  const notas = alunos.length > 0
    ? await queryAsync(
      `SELECT student_id, disciplina_id, valor, tipo_avaliacao, bloqueada
       FROM grades WHERE school_id = ? AND turma_id = ?`,
      [schoolId, turmaId]
    )
    : [];

  let faltasPorAluno = {};
  if (alunos.length > 0) {
    try {
      const faltasRows = await queryAsync(
        `SELECT student_id, COUNT(*) as total FROM presencas
         WHERE school_id = ? AND turma_id = ? AND status = 'falta' GROUP BY student_id`,
        [schoolId, turmaId]
      );
      faltasPorAluno = Object.fromEntries(faltasRows.map((r) => [r.student_id, r.total]));
    } catch (e) {
      faltasPorAluno = {}; // tabela de presenças pode ainda não existir
    }
  }

  const linhas = alunos.map((aluno) => {
    const notasAluno = notas.filter((n) => n.student_id === aluno.id);
    const totalFaltas = faltasPorAluno[aluno.id] || 0;
    const excluidoPorFaltas = totalFaltas >= faltasMaxPPF;

    const notasPorDisciplina = {};
    const situacoes = [];

    disciplinas.forEach((disc) => {
      const doDisc = notasAluno.filter((n) => n.disciplina_id === disc.id);
      const testes = doDisc.filter((n) => /^Teste/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
      const trabalhos = doDisc.filter((n) => /^Trabalho/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
      const acpRow = doDisc.find((n) => /^ACP/i.test(String(n.tipo_avaliacao || '')));
      const exameRow = doDisc.find((n) => /^Exame/i.test(String(n.tipo_avaliacao || '')));

      const media = calcularMediaDisciplina({
        testes, trabalhos,
        acp: acpRow ? { valor: parseFloat(acpRow.valor) } : null,
        exame: exameRow ? { valor: parseFloat(exameRow.valor) } : null,
      }, config);

      const completo = avaliacaoContinuaCompleta({ testes, trabalhos, acp: acpRow }, config);
      const { situacao } = calcularSituacaoDisciplina(media, !!exameRow, config, completo);
      situacoes.push(situacao);
      notasPorDisciplina[disc.id] = { media, situacao, completo, nome: disc.nome, classificacao: classificarQualitativamente(media) };
    });

    const mediasValidas = Object.values(notasPorDisciplina).map((d) => d.media).filter((m) => m !== null && m !== undefined);
    const mediaGeral = mediasValidas.length > 0
      ? parseFloat((mediasValidas.reduce((s, m) => s + m, 0) / mediasValidas.length).toFixed(2))
      : null;
    const situacaoGeral = calcularSituacaoGeral(
      situacoes,
      excluidoPorFaltas,
      { disciplinasDetalhe: Object.values(notasPorDisciplina).map((d) => ({ nome: d.nome, media: d.media, situacao: d.situacao })), mediaGeral, classeNome: turma.classe_nome, possuiExame: !!turma.possui_exame }
    );

    return {
      student_id: aluno.id,
      nome: aluno.nome,
      codigo_aluno: aluno.codigo_aluno,
      notas: notasPorDisciplina,
      media_geral: mediaGeral,
      classificacao_geral: classificarQualitativamente(mediaGeral),
      total_faltas: totalFaltas,
      excluido_por_faltas: excluidoPorFaltas,
      situacao_geral: situacaoGeral,
    };
  });

  return {
    turma: { id: turma.id, nome: turma.nome, classe_nome: turma.classe_nome },
    disciplinas,
    config,
    faltas_max_ppf: faltasMaxPPF,
    alunos: linhas,
    // v114 — true se pelo menos um aluno tem avaliação contínua incompleta em
    // alguma disciplina (situacao_geral 'Incompleto'). A Pauta Oficial em PDF
    // usa isto para avisar, antes de a escola submeter o documento à Direção
    // Provincial, que os dados ainda não estão completos.
    tem_dados_incompletos: linhas.some((a) => a.situacao_geral === 'Incompleto'),
  };
};

export const getBoletimTurma = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await montarDadosPautaTurma(schoolId, turmaId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    res.json({ success: true, ...dados });
  } catch (err) {
    console.error('[v0] Erro ao montar tabela de avaliação da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar tabela de avaliação da turma', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/turmas/:turmaId/pauta-oficial/pdf — v111
 * Pauta oficial de avaliação em PDF, formatada para submissão à Direção
 * Provincial de Educação: cabeçalho com identificação da escola (nome,
 * NUIT, endereço, província), turma/classe/secção, tabela aluno × disciplina
 * com médias e situação, e bloco de assinatura no rodapé.
 */
export const gerarPautaOficialPDF = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await montarDadosPautaTurma(schoolId, turmaId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    if (dados.disciplinas.length === 0) {
      return res.status(400).json({ success: false, message: 'Esta turma ainda não tem disciplinas configuradas — configure o currículo na aba Disciplinas antes de exportar a pauta.' });
    }

    const escolaRows = await queryAsync(`SELECT name, nuit, address, provincia FROM schools WHERE id = ?`, [schoolId]);
    const escola = escolaRows[0] || {};
    const { turma, disciplinas, alunos, faltas_max_ppf: faltasMaxPPF, tem_dados_incompletos: temDadosIncompletos } = dados;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pauta-oficial-${(turma.nome || 'turma').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    doc.pipe(res);

    const larguraUtil = doc.page.width - 72; // margens de 36pt de cada lado

    // ── Cabeçalho oficial ──────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#475569')
      .text(escola.provincia ? `República de Moçambique — Direção Provincial de Educação de ${escola.provincia}` : 'República de Moçambique', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(15).font('Helvetica-Bold').fillColor('#000000').text(escola.name || 'Escola', { align: 'center' });
    const linhaContacto = [escola.address, escola.nuit ? `NUIT: ${escola.nuit}` : null].filter(Boolean).join('   ·   ');
    if (linhaContacto) doc.fontSize(9).font('Helvetica').fillColor('#475569').text(linhaContacto, { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000000').text('PAUTA OFICIAL DE AVALIAÇÃO', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica').fillColor('#334155').text(
      `Turma: ${turma.nome || '—'}    Classe: ${turma.classe_nome || '—'}    Data de emissão: ${new Date().toLocaleDateString('pt-PT')}`,
      { align: 'center' }
    );
    doc.moveDown(0.4);
    // v114 — a média redistribui o peso proporcionalmente entre os
    // componentes já lançados (ver calcularMediaDisciplina em
    // gradeController.js): com dados incompletos, "Aprovado"/"Reprovado"
    // ainda não é o veredito oficial. Avisa antes de a escola submeter isto
    // à Direção Provincial de Educação.
    if (temDadosIncompletos) {
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#b45309').text(
        'ATENÇÃO: esta turma tem pelo menos um aluno com avaliação contínua ainda incompleta (situação "Incompleto") — confirme que todas as notas foram lançadas antes de submeter esta pauta.',
        { align: 'center' }
      );
      doc.moveDown(0.2);
    }
    doc.moveDown(0.4);
    doc.strokeColor('#94a3b8').lineWidth(1).moveTo(36, doc.y).lineTo(36 + larguraUtil, doc.y).stroke();
    doc.moveDown(0.6);

    // ── Tabela ──────────────────────────────────────────────────────────
    const colNumero = 24;
    const colNome = 150;
    const colFaltas = 42;
    const colMedia = 42;
    const colSituacao = 68;
    const larguraFixas = colNumero + colNome + colFaltas + colMedia + colSituacao;
    const colDisciplina = Math.max((larguraUtil - larguraFixas) / disciplinas.length, 34);
    const tamanhoFonteTabela = disciplinas.length > 10 ? 6.5 : disciplinas.length > 6 ? 7.5 : 8.5;

    const desenharCabecalhoTabela = () => {
      const yInicio = doc.y;
      doc.fontSize(tamanhoFonteTabela).font('Helvetica-Bold').fillColor('#ffffff');
      doc.rect(36, yInicio, larguraUtil, 22).fill('#1e293b');
      doc.fillColor('#ffffff');
      let x = 36;
      doc.text('Nº', x, yInicio + 6, { width: colNumero, align: 'center' }); x += colNumero;
      doc.text('Aluno', x + 3, yInicio + 6, { width: colNome - 3 }); x += colNome;
      disciplinas.forEach((disc) => {
        doc.text(disc.nome.slice(0, 12), x + 1, yInicio + 6, { width: colDisciplina - 2, align: 'center' });
        x += colDisciplina;
      });
      doc.text('Faltas', x, yInicio + 6, { width: colFaltas, align: 'center' }); x += colFaltas;
      doc.text('Média', x, yInicio + 6, { width: colMedia, align: 'center' }); x += colMedia;
      doc.text('Situação', x, yInicio + 6, { width: colSituacao, align: 'center' });
      doc.y = yInicio + 22;
    };

    desenharCabecalhoTabela();

    const alturaLinha = 18;
    alunos.forEach((aluno, i) => {
      if (doc.y + alturaLinha > doc.page.height - 90) {
        doc.addPage();
        doc.y = 36;
        desenharCabecalhoTabela();
      }
      const yLinha = doc.y;
      if (i % 2 === 1) doc.rect(36, yLinha, larguraUtil, alturaLinha).fill('#f8fafc');
      doc.fillColor('#1e293b').font('Helvetica').fontSize(tamanhoFonteTabela);
      let x = 36;
      doc.text(String(i + 1), x, yLinha + 5, { width: colNumero, align: 'center' }); x += colNumero;
      doc.text(aluno.nome.slice(0, 28), x + 3, yLinha + 5, { width: colNome - 3 }); x += colNome;
      disciplinas.forEach((disc) => {
        const n = aluno.notas[disc.id];
        doc.text(n?.media != null ? n.media.toFixed(1) : '—', x, yLinha + 5, { width: colDisciplina, align: 'center' });
        x += colDisciplina;
      });
      doc.text(aluno.excluido_por_faltas ? `${aluno.total_faltas}*` : String(aluno.total_faltas), x, yLinha + 5, { width: colFaltas, align: 'center' }); x += colFaltas;
      doc.font('Helvetica-Bold').text(aluno.media_geral != null ? aluno.media_geral.toFixed(1) : '—', x, yLinha + 5, { width: colMedia, align: 'center' }); x += colMedia;
      doc.font('Helvetica').text(aluno.situacao_geral || '—', x, yLinha + 5, { width: colSituacao, align: 'center' });
      doc.y = yLinha + alturaLinha;
    });

    doc.moveDown(0.8);
    doc.fontSize(7.5).font('Helvetica').fillColor('#64748b')
      .text(`* Excluído por faltas (limite PPF: ${faltasMaxPPF} faltas). Médias calculadas segundo os critérios de avaliação configurados pela escola. "Incompleto" = avaliação contínua (testes/trabalhos/ACP) ainda por lançar na íntegra — média e situação ainda não são definitivas.`, 36, doc.y, { width: larguraUtil });
    doc.moveDown(0.15);
    doc.fontSize(7.5).font('Helvetica').fillColor('#64748b')
      .text(`Classificação qualitativa (Artigo 31.º do Regulamento Geral de Avaliação, Diploma Ministerial n.º 59/2015): ${ESCALA_QUALITATIVA.slice().reverse().map((f) => `${f.min}–${f.max} ${f.label}`).join(' · ')}.`, 36, doc.y, { width: larguraUtil });

    // ── Bloco de assinatura ─────────────────────────────────────────────
    if (doc.y > doc.page.height - 110) { doc.addPage(); doc.y = 36; }
    doc.moveDown(2.5);
    const yAssinatura = doc.y;
    const largaAssinatura = 220;
    doc.strokeColor('#334155').lineWidth(0.7)
      .moveTo(60, yAssinatura).lineTo(60 + largaAssinatura, yAssinatura).stroke()
      .moveTo(larguraUtil - largaAssinatura + 12, yAssinatura).lineTo(larguraUtil + 12, yAssinatura).stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#334155');
    doc.text('O(A) Secretário(a) Pedagógico(a)', 60, yAssinatura + 4, { width: largaAssinatura, align: 'center' });
    doc.text('O(A) Diretor(a)', larguraUtil - largaAssinatura + 12, yAssinatura + 4, { width: largaAssinatura, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar pauta oficial em PDF:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar pauta oficial em PDF', error: err.message });
  }
};

/**
 * PUT: Atualizar uma nota existente
 */
export const updateGrade = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    const { schoolId, gradeId } = req.params;
    const { valor, tipo_avaliacao, data_avaliacao, periodo, observacoes } = req.body;

    const notaRows = await queryAsync(`SELECT * FROM grades WHERE id = ? AND school_id = ?`, [gradeId, schoolId]);
    if (notaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Nota não encontrada' });
    }
    if (notaRows[0].bloqueada) {
      return res.status(403).json({ success: false, message: 'Esta nota está bloqueada e não pode ser editada' });
    }
    const notaAntiga = notaRows[0];

    if (tipo_avaliacao !== undefined) {
      const config = await getConfigAvaliacao(schoolId);
      let classeNome = null;
      let classeId = null;
      if (notaAntiga.turma_id) {
        const turmaRows = await queryAsync(
          `SELECT t.class_id, c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ?`,
          [notaAntiga.turma_id, schoolId]
        );
        classeId = turmaRows[0]?.class_id || null;
        classeNome = turmaRows[0]?.classe_nome || null;
      }
      const temExameNestaClasse = await classeTemExameEfetivo(schoolId, classeId, classeNome, config);
      let tiposPermitidos = listarTiposPermitidos(config, temExameNestaClasse);
      // v151 — mesma exceção por aluno individual do createGrade: se a
      // classe não tem exame em geral mas ESTE aluno está "Vai a Exame"
      // nesta disciplina, continua a poder editar/lançar a nota de exame.
      const ehTipoExame = tipo_avaliacao === 'Exame' || tipo_avaliacao === 'Exame (2ª Época)';
      if (!tiposPermitidos.includes(tipo_avaliacao) && ehTipoExame && config.usa_exame) {
        const alunoElegivel = await alunoElegivelParaExameNaDisciplina(schoolId, notaAntiga.student_id, notaAntiga.disciplina_id, config);
        if (alunoElegivel) tiposPermitidos = [...tiposPermitidos, 'Exame', 'Exame (2ª Época)'];
      }
      if (!tiposPermitidos.includes(tipo_avaliacao)) {
        return res.status(400).json({ success: false, message: `Tipo de avaliação inválido. Tipos permitidos: ${tiposPermitidos.join(', ')}` });
      }
    }

    if (valor !== undefined && valor !== null && valor !== '') {
      const valorNumerico = parseFloat(valor);
      if (isNaN(valorNumerico) || valorNumerico < ESCALA_MIN || valorNumerico > ESCALA_MAX) {
        return res.status(400).json({ success: false, message: `A nota deve estar entre ${ESCALA_MIN} e ${ESCALA_MAX}` });
      }
    }

    const campos = [];
    const valores = [];
    if (valor !== undefined) { campos.push('valor = ?'); valores.push(parseFloat(valor)); }
    if (tipo_avaliacao !== undefined) { campos.push('tipo_avaliacao = ?'); valores.push(tipo_avaliacao); }
    if (data_avaliacao !== undefined) {
      campos.push('data_avaliacao = ?'); valores.push(data_avaliacao);
      const anoLetivoResolvido = await resolverAnoLetivoPorData(schoolId, data_avaliacao);
      const anoLetivo = /^\d+$/.test(anoLetivoResolvido.nome)
        ? parseInt(anoLetivoResolvido.nome, 10)
        : new Date(anoLetivoResolvido.data_inicio).getFullYear();
      campos.push('ano_letivo = ?'); valores.push(anoLetivo);
      campos.push('academic_year_id = ?'); valores.push(anoLetivoResolvido.virtual ? null : anoLetivoResolvido.id);
    }
    if (periodo !== undefined) { campos.push('periodo = ?'); valores.push(periodo); }
    if (observacoes !== undefined) { campos.push('observacoes = ?'); valores.push(observacoes); }

    if (campos.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar' });
    }

    campos.push('updated_at = NOW()');
    valores.push(gradeId, schoolId);

    await queryAsync(`UPDATE grades SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);

    const [notaNova] = await queryAsync(`SELECT * FROM grades WHERE id = ? AND school_id = ?`, [gradeId, schoolId]);
    await registrarAuditoria(req, {
      acao: 'nota_editada', entidadeTipo: 'grade', entidadeId: gradeId,
      dadosAntigos: notaAntiga, dadosNovos: notaNova,
    });

    res.json({ success: true, message: 'Nota atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar nota:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar nota', error: err.message });
  }
};

/**
 * DELETE: Remover uma nota
 */
export const deleteGrade = async (req, res) => {
  try {
    const { schoolId, gradeId } = req.params;

    const notaRows = await queryAsync(`SELECT * FROM grades WHERE id = ? AND school_id = ?`, [gradeId, schoolId]);
    if (notaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Nota não encontrada' });
    }
    if (notaRows[0].bloqueada) {
      return res.status(403).json({ success: false, message: 'Esta nota está bloqueada e não pode ser excluída' });
    }

    await queryAsync(`DELETE FROM grades WHERE id = ? AND school_id = ?`, [gradeId, schoolId]);
    await registrarAuditoria(req, {
      acao: 'nota_removida', entidadeTipo: 'grade', entidadeId: gradeId, dadosAntigos: notaRows[0],
    });

    res.json({ success: true, message: 'Nota removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover nota:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover nota', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// BOLETINS EM LOTE (PDF) — usado pela ação em massa "Boletins PDF" na aba
// Alunos. Gera um único ficheiro PDF com uma página por aluno, mostrando o
// resumo do ano letivo mais recente (disciplinas, médias e situação).
// ═══════════════════════════════════════════════════════════════════════════
const buscarResumoAnualAluno = async (schoolId, studentId, config) => {
  const linhas = await queryAsync(
    `
      SELECT g.disciplina_id, d.nome as disciplina_nome, g.valor, g.tipo_avaliacao,
             COALESCE(g.ano_letivo, YEAR(g.data_avaliacao), YEAR(g.created_at)) as ano_letivo,
             COALESCE(g.classe_id, t.class_id) as classe_id,
             c.nome as classe_nome
      FROM grades g
      LEFT JOIN disciplinas d ON d.id = g.disciplina_id
      LEFT JOIN turmas t ON t.id = g.turma_id
      LEFT JOIN classes c ON c.id = COALESCE(g.classe_id, t.class_id)
      WHERE g.school_id = ? AND g.student_id = ?
    `,
    [schoolId, studentId]
  );

  if (linhas.length === 0) {
    return { ano_letivo: null, disciplinas: [], media_geral: null, situacao_geral: 'Sem notas' };
  }

  const anoMaisRecente = Math.max(...linhas.map((l) => l.ano_letivo || 0));
  const linhasDoAno = linhas.filter((l) => l.ano_letivo === anoMaisRecente);

  // v153 — classe (e "tem exame") do ano em resumo, para a situação geral
  // usar a MESMA terminologia (Aprovado/Reprovado vs. Transita/Não Transita)
  // e a mesma tolerância de transição do ESG1 já aplicadas no boletim
  // individual (montarBoletimAluno) — antes esta função nunca passava
  // contexto a calcularSituacaoGeral(), pelo que o PDF em lote "Boletins
  // PDF" sempre mostrava Aprovado/Reprovado, mesmo em classes sem exame.
  const classeId = linhasDoAno.find((l) => l.classe_id)?.classe_id || null;
  const classeNome = linhasDoAno.find((l) => l.classe_nome)?.classe_nome || null;
  const possuiExame = classeId ? await classeTemExameEfetivo(schoolId, classeId, classeNome, config) : !!config.usa_exame;

  const discMap = new Map();
  linhasDoAno.forEach((linha) => {
    if (!discMap.has(linha.disciplina_id)) {
      discMap.set(linha.disciplina_id, {
        disciplina_nome: linha.disciplina_nome || `Disciplina #${linha.disciplina_id}`,
        testes: [], trabalhos: [], acp: null, exame: null,
      });
    }
    const disc = discMap.get(linha.disciplina_id);
    const tipo = String(linha.tipo_avaliacao || '');
    const item = { valor: parseFloat(linha.valor) };
    if (/^Teste/i.test(tipo)) disc.testes.push(item);
    else if (/^Trabalho/i.test(tipo)) disc.trabalhos.push(item);
    else if (/^ACP/i.test(tipo)) disc.acp = item;
    else if (/^Exame/i.test(tipo)) disc.exame = item;
    else disc.trabalhos.push(item);
  });

  const disciplinas = Array.from(discMap.values())
    .map((disc) => {
      const media = calcularMediaDisciplina(disc, config);
      const completo = avaliacaoContinuaCompleta(disc, config);
      const { situacao } = calcularSituacaoDisciplina(media, disc.exame != null, config, completo);
      return { nome: disc.disciplina_nome, media, situacao, completo, classificacao: classificarQualitativamente(media) };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome));

  const mediasValidas = disciplinas.map((d) => d.media).filter((m) => m !== null && m !== undefined);
  const mediaGeral = mediasValidas.length > 0
    ? parseFloat((mediasValidas.reduce((s, m) => s + m, 0) / mediasValidas.length).toFixed(2))
    : null;
  const situacaoGeral = calcularSituacaoGeral(
    disciplinas.map((d) => d.situacao),
    false,
    { disciplinasDetalhe: disciplinas.map((d) => ({ nome: d.nome, media: d.media, situacao: d.situacao })), mediaGeral, classeNome, possuiExame }
  );

  return {
    ano_letivo: anoMaisRecente, disciplinas, media_geral: mediaGeral, situacao_geral: situacaoGeral,
    classificacao_geral: classificarQualitativamente(mediaGeral),
  };
};

/**
 * POST /schools/:schoolId/students/bulk-boletins-pdf
 * Body: { studentIds: [1, 2, 3, ...] }
 */
export const gerarBoletinsEmLotePDF = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    const { schoolId } = req.params;
    const { studentIds } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione pelo menos um aluno' });
    }

    const config = await getConfigAvaliacao(schoolId);
    const escolaRows = await queryAsync(`SELECT name, address, phone FROM schools WHERE id = ?`, [schoolId]);
    const escola = escolaRows[0] || {};

    const placeholders = studentIds.map(() => '?').join(',');
    const alunos = await queryAsync(
      `
        SELECT s.id, s.nome, s.codigo_aluno, t.nome as turma_nome, c.nome as classe_nome, sec.nome as secao_nome
        FROM students s
        LEFT JOIN turmas t ON t.id = s.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        -- v143 — secção via students.secao_id, para o boletim continuar
        -- correto em modo turma-mista (ver nota em studentController.getAllStudents)
        LEFT JOIN secoes sec ON sec.id = s.secao_id
        WHERE s.school_id = ? AND s.id IN (${placeholders})
        ORDER BY s.nome ASC
      `,
      [schoolId, ...studentIds]
    );

    if (alunos.length === 0) {
      return res.status(404).json({ success: false, message: 'Nenhum aluno encontrado' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="boletins.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    for (let i = 0; i < alunos.length; i++) {
      const aluno = alunos[i];
      if (i > 0) doc.addPage();

      const resumo = await buscarResumoAnualAluno(schoolId, aluno.id, config);

      doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text(escola.name || 'Escola', { align: 'center' });
      if (escola.address) doc.fontSize(9).font('Helvetica').fillColor('#475569').text(escola.address, { align: 'center' });
      doc.moveDown(1);
      doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('Boletim de Notas', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(resumo.ano_letivo ? `Ano Letivo de ${resumo.ano_letivo}` : 'Sem ano letivo com notas', { align: 'center' });
      doc.moveDown(1);
      doc.strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(1);

      const linha = (label, valor) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1e293b').text(label, 50, doc.y, { continued: true, width: 150 });
        doc.font('Helvetica').fillColor('#334155').text(`  ${valor ?? '—'}`);
        doc.moveDown(0.5);
      };
      linha('Aluno:', aluno.nome);
      linha('Código:', aluno.codigo_aluno);
      linha('Turma:', aluno.turma_nome);
      linha('Classe:', aluno.classe_nome);
      if (aluno.secao_nome) linha('Secção:', aluno.secao_nome);

      doc.moveDown(0.5);
      doc.strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text('Disciplina', 50, doc.y, { continued: true, width: 220 });
      doc.text('Média', { continued: true, width: 80 });
      doc.text('Classificação', { continued: true, width: 120 });
      doc.text('Situação');
      doc.moveDown(0.3);
      doc.strokeColor('#cbd5e1').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);

      if (resumo.disciplinas.length === 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#94a3b8').text('Sem notas lançadas neste ano letivo.');
      } else {
        resumo.disciplinas.forEach((d) => {
          doc.fontSize(10).font('Helvetica').fillColor('#334155').text(d.nome, 50, doc.y, { continued: true, width: 220 });
          doc.text(d.media !== null && d.media !== undefined ? d.media.toFixed(1) : '—', { continued: true, width: 80 });
          doc.text(d.classificacao || '—', { continued: true, width: 120 });
          doc.text(d.situacao || '—');
          doc.moveDown(0.35);
        });
      }

      doc.moveDown(1);
      doc.strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.8);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b').text(
        `Média Geral: ${resumo.media_geral !== null && resumo.media_geral !== undefined ? resumo.media_geral.toFixed(1) : '—'} (${resumo.classificacao_geral || '—'})     Situação: ${resumo.situacao_geral || '—'}`
      );
      doc.moveDown(0.4);
      doc.fontSize(7.5).font('Helvetica').fillColor('#94a3b8').text(
        `Classificação qualitativa (Artigo 31.º do Regulamento Geral de Avaliação): ${ESCALA_QUALITATIVA.slice().reverse().map((f) => `${f.min}–${f.max} ${f.label}`).join(' · ')}.`,
        { width: 495 }
      );

      doc.moveDown(1.2);
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text(
        `Gerado automaticamente pelo FalconEducation em ${new Date().toLocaleString('pt-PT')}.`,
        { align: 'center' }
      );
    }

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar boletins em lote:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Erro ao gerar boletins em lote', error: err.message });
    }
  }
};

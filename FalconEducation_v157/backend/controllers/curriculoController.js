import db from '../config/db.js';
import { ensureClassDisciplinaSecaoColumnExists } from './secaoController.js';
import { registrarAuditoria } from '../services/auditService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * INFRAESTRUTURA (auto-criação de tabelas — mesmo padrão usado em outros
 * controllers deste projeto, ex.: ensurePresencasTableExists)
 * ═══════════════════════════════════════════════════════════════════════
 */
// Cache simples em memória: cada "ensureXxx" migra a base de dados (CREATE
// TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN se faltar) — são operações
// idempotentes, mas não precisam de correr em CADA pedido. Com memoize(),
// corre uma vez (a primeira chamada depois de o servidor arrancar) e todas as
// chamadas seguintes ficam instantâneas, reduzindo uma ida à base de dados por
// pedido em todas as rotas que dependem destas tabelas.
const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

export const ensureClassDisciplinasTableExists = memoize(async () => {
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
});

const columnExists = async (table, column) => {
  const result = await queryAsync(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return result.length > 0;
};

export const ensureAvaliacaoConfigTableExists = memoize(async () => {
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
  if (!(await columnExists('avaliacao_config', 'nota_minima_aprovacao'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_minima_aprovacao DECIMAL(5,2) NOT NULL DEFAULT 10 AFTER peso_exame`);
  }
  if (!(await columnExists('avaliacao_config', 'nota_minima_exame'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_minima_exame DECIMAL(5,2) NOT NULL DEFAULT 10 AFTER nota_minima_aprovacao`);
  }
  if (!(await columnExists('avaliacao_config', 'nota_dispensa'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN nota_dispensa DECIMAL(5,2) NOT NULL DEFAULT 14 AFTER nota_minima_exame`);
  }
  // v139 — ver comentário idêntico em gradeController.js (mesma tabela,
  // provisionamento defensivo duplicado propositadamente desde a v121).
  if (!(await columnExists('avaliacao_config', 'usar_tolerancia_transicao_esg1'))) {
    await queryAsync(`ALTER TABLE avaliacao_config ADD COLUMN usar_tolerancia_transicao_esg1 TINYINT(1) NOT NULL DEFAULT 0 AFTER nota_dispensa`);
  }
});

// Tabela de configuração do PPF (limite de faltas antes da exclusão do aluno),
// usada na área de Gestão de Presenças
export const ensurePresencaConfigTableExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS presenca_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      faltas_max_ppf INT NOT NULL DEFAULT 30,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// Garante que a escola tenha classes 1ª a 12ª cadastradas (mesmo padrão de
// seed automático usado no catálogo de disciplinas)
const seedClassesPadrao = async (schoolId) => {
  // Garante que as classes "1ª Classe" a "12ª Classe" (sistema de ensino de Moçambique)
  // sempre existam para a escola — completa apenas o que estiver faltando, sem duplicar
  // nem mexer em classes que a escola já tenha criado com outros nomes.
  const nomesPadrao = Array.from({ length: 12 }, (_, i) => `${i + 1}ª Classe`);
  const existentesRows = await queryAsync(`SELECT nome FROM classes WHERE school_id = ?`, [schoolId]);
  const existentesSet = new Set(existentesRows.map((r) => r.nome));
  const faltantes = nomesPadrao.filter((nome) => !existentesSet.has(nome));
  if (faltantes.length === 0) return;

  const values = faltantes.map((nome) => [schoolId, nome, `Série ${nome}`, true]);
  await queryAsync(
    `INSERT INTO classes (school_id, nome, descricao, ativa, created_at, updated_at)
     VALUES ${values.map(() => '(?, ?, ?, ?, NOW(), NOW())').join(', ')}`,
    values.flat()
  );
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CLASSES
 * ═══════════════════════════════════════════════════════════════════════
 */

// GET: lista as classes da escola (faz seed automático de 1ª a 12ª na 1ª vez)
export const getClasses = async (req, res) => {
  try {
    const { schoolId } = req.params;

    await seedClassesPadrao(schoolId);

    const classes = await queryAsync(
      `SELECT id, nome, descricao, ativa FROM classes WHERE school_id = ? ORDER BY
         CAST(REGEXP_REPLACE(nome, '[^0-9]', '') AS UNSIGNED) ASC, nome ASC`,
      [schoolId]
    );

    res.json({ success: true, data: classes });
  } catch (err) {
    console.error('[v0] Erro ao listar classes:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar classes', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DISCIPLINAS POR CLASSE (currículo)
 * ═══════════════════════════════════════════════════════════════════════
 */

// GET: disciplinas atualmente associadas a uma classe. Aceita ?secao_id= —
// quando indicado, devolve as disciplinas COMUNS a todas as secções (secao_id
// = 0) MAIS as específicas dessa secção, cada uma já marcada em `comum` para
// o frontend distinguir (uma disciplina comum não pode ser removida a partir
// da vista de uma secção específica — só a partir da vista "Comum").
export const getDisciplinasDaClasse = async (req, res) => {
  try {
    await ensureClassDisciplinasTableExists();
    await ensureClassDisciplinaSecaoColumnExists();
    const { schoolId, classeId } = req.params;
    const secaoId = Number(req.query.secao_id) || 0;

    const disciplinas = await queryAsync(
      `
        SELECT d.id, d.nome, d.codigo, d.carga_horaria_semanal, cd.secao_id,
               (cd.secao_id = 0) as comum
        FROM class_disciplinas cd
        INNER JOIN disciplinas d ON d.id = cd.disciplina_id
        WHERE cd.school_id = ? AND cd.classe_id = ? AND cd.secao_id IN (0, ?)
        ORDER BY d.nome ASC
      `,
      [schoolId, classeId, secaoId]
    );

    res.json({ success: true, data: disciplinas });
  } catch (err) {
    console.error('[v0] Erro ao listar disciplinas da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar disciplinas da classe', error: err.message });
  }
};

/**
 * GET: Visão geral do currículo — todas as classes x todas as disciplinas de uma
 * só vez, para montar uma tabela/matriz de consulta rápida (sem precisar abrir
 * classe por classe). Também indica quantas classes cada disciplina atende.
 */
export const getCurriculoGeral = async (req, res) => {
  try {
    await ensureClassDisciplinasTableExists();
    await ensureClassDisciplinaSecaoColumnExists();
    const { schoolId } = req.params;

    await seedClassesPadrao(schoolId);

    const classes = await queryAsync(
      `SELECT id, nome FROM classes WHERE school_id = ? AND ativa = TRUE
       ORDER BY CAST(REGEXP_REPLACE(nome, '[^0-9]', '') AS UNSIGNED) ASC, nome ASC`,
      [schoolId]
    );
    const disciplinas = await queryAsync(
      `SELECT id, nome FROM disciplinas WHERE school_id = ? AND ativa = TRUE ORDER BY nome ASC`,
      [schoolId]
    );
    // v94 — só as disciplinas COMUNS (secao_id = 0) entram nesta visão geral
    // simples; disciplinas específicas de uma secção só aparecem dentro da
    // gestão "Currículo por Classe" → separador daquela secção, para não
    // confundir esta matriz simples de classe×disciplina.
    const associacoes = await queryAsync(
      `SELECT classe_id, disciplina_id FROM class_disciplinas WHERE school_id = ? AND secao_id = 0`,
      [schoolId]
    );

    // matriz[classe_id] = [disciplina_id, disciplina_id, ...]
    const matriz = {};
    classes.forEach((c) => { matriz[c.id] = []; });
    associacoes.forEach((a) => {
      if (!matriz[a.classe_id]) matriz[a.classe_id] = [];
      matriz[a.classe_id].push(a.disciplina_id);
    });

    res.json({ success: true, classes, disciplinas, matriz });
  } catch (err) {
    console.error('[v0] Erro ao buscar visão geral do currículo:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar visão geral do currículo', error: err.message });
  }
};

// PUT: substitui a lista completa de disciplinas associadas a uma classe
// PARA UMA SECÇÃO ESPECÍFICA (ou "Comum", quando secao_id é 0/omitido) — só
// mexe nas linhas dessa secção; as de outras secções (ou as comuns, quando
// se está a editar uma secção) ficam intocadas.
// Body: { disciplina_ids: [1, 2, 3], secao_id?: number }
export const salvarDisciplinasDaClasse = async (req, res) => {
  try {
    await ensureClassDisciplinasTableExists();
    await ensureClassDisciplinaSecaoColumnExists();
    const { schoolId, classeId } = req.params;
    const { disciplina_ids = [], secao_id: secaoIdBody } = req.body;
    const secaoId = Number(secaoIdBody) || 0;

    if (!Array.isArray(disciplina_ids)) {
      return res.status(400).json({ success: false, message: 'disciplina_ids deve ser uma lista' });
    }

    const classeRows = await queryAsync(`SELECT id FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
    if (classeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe não encontrada' });
    }

    if (secaoId !== 0) {
      const secaoRows = await queryAsync(`SELECT id FROM secoes WHERE id = ? AND school_id = ? AND classe_id = ?`, [secaoId, schoolId, classeId]);
      if (secaoRows.length === 0) {
        return res.status(400).json({ success: false, message: 'Secção inválida para esta classe' });
      }
    }

    await queryAsync(`DELETE FROM class_disciplinas WHERE school_id = ? AND classe_id = ? AND secao_id = ?`, [schoolId, classeId, secaoId]);

    const idsValidos = disciplina_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (idsValidos.length > 0) {
      const values = idsValidos.map((disciplinaId) => [schoolId, classeId, secaoId, disciplinaId]);
      await queryAsync(
        `INSERT IGNORE INTO class_disciplinas (school_id, classe_id, secao_id, disciplina_id, created_at)
         VALUES ${values.map(() => '(?, ?, ?, ?, NOW())').join(', ')}`,
        values.flat()
      );
    }

    res.json({ success: true, message: 'Disciplinas da classe atualizadas com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar disciplinas da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar disciplinas da classe', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CONFIGURAÇÃO DE AVALIAÇÃO (quantidade de testes/trabalhos e pesos usados
 * para calcular a média final de cada disciplina)
 * ═══════════════════════════════════════════════════════════════════════
 */

const VALORES_PADRAO_AVALIACAO = {
  qtd_testes: 2,
  qtd_trabalhos: 2,
  usa_acp: true,
  usa_exame: true,
  peso_testes: 40,
  peso_trabalhos: 10,
  peso_acp: 20,
  peso_exame: 30,
  nota_minima_aprovacao: 10,
  nota_minima_exame: 10,
  nota_dispensa: 14,
};

// GET: configuração de avaliação da escola (cria uma padrão na 1ª vez)
export const getAvaliacaoConfig = async (req, res) => {
  try {
    await ensureAvaliacaoConfigTableExists();
    const { schoolId } = req.params;

    let rows = await queryAsync(`SELECT * FROM avaliacao_config WHERE school_id = ? LIMIT 1`, [schoolId]);

    if (rows.length === 0) {
      await queryAsync(
        `INSERT INTO avaliacao_config
           (school_id, qtd_testes, qtd_trabalhos, usa_acp, usa_exame, peso_testes, peso_trabalhos, peso_acp, peso_exame, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          schoolId,
          VALORES_PADRAO_AVALIACAO.qtd_testes,
          VALORES_PADRAO_AVALIACAO.qtd_trabalhos,
          VALORES_PADRAO_AVALIACAO.usa_acp,
          VALORES_PADRAO_AVALIACAO.usa_exame,
          VALORES_PADRAO_AVALIACAO.peso_testes,
          VALORES_PADRAO_AVALIACAO.peso_trabalhos,
          VALORES_PADRAO_AVALIACAO.peso_acp,
          VALORES_PADRAO_AVALIACAO.peso_exame,
        ]
      );
      rows = await queryAsync(`SELECT * FROM avaliacao_config WHERE school_id = ? LIMIT 1`, [schoolId]);
    }

    const config = rows[0];
    res.json({
      success: true,
      data: {
        qtd_testes: config.qtd_testes,
        qtd_trabalhos: config.qtd_trabalhos,
        usa_acp: !!config.usa_acp,
        usa_exame: !!config.usa_exame,
        peso_testes: parseFloat(config.peso_testes),
        peso_trabalhos: parseFloat(config.peso_trabalhos),
        peso_acp: parseFloat(config.peso_acp),
        peso_exame: parseFloat(config.peso_exame),
        nota_minima_aprovacao: parseFloat(config.nota_minima_aprovacao ?? VALORES_PADRAO_AVALIACAO.nota_minima_aprovacao),
        nota_minima_exame: parseFloat(config.nota_minima_exame ?? VALORES_PADRAO_AVALIACAO.nota_minima_exame),
        nota_dispensa: parseFloat(config.nota_dispensa ?? VALORES_PADRAO_AVALIACAO.nota_dispensa),
        usar_tolerancia_transicao_esg1: !!config.usar_tolerancia_transicao_esg1,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar configuração de avaliação:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração de avaliação', error: err.message });
  }
};

// PUT: salva a configuração de avaliação da escola
export const salvarAvaliacaoConfig = async (req, res) => {
  try {
    await ensureAvaliacaoConfigTableExists();
    const { schoolId } = req.params;
    const {
      qtd_testes, qtd_trabalhos, usa_acp, usa_exame,
      peso_testes, peso_trabalhos, peso_acp, peso_exame,
      nota_minima_aprovacao, nota_minima_exame, nota_dispensa,
      usar_tolerancia_transicao_esg1,
    } = req.body;

    const qtdTestesNum = parseInt(qtd_testes, 10);
    const qtdTrabalhosNum = parseInt(qtd_trabalhos, 10);
    if (!Number.isFinite(qtdTestesNum) || qtdTestesNum < 0 || qtdTestesNum > 10) {
      return res.status(400).json({ success: false, message: 'Quantidade de testes inválida (0 a 10)' });
    }
    if (!Number.isFinite(qtdTrabalhosNum) || qtdTrabalhosNum < 0 || qtdTrabalhosNum > 10) {
      return res.status(400).json({ success: false, message: 'Quantidade de trabalhos inválida (0 a 10)' });
    }

    const usaAcpBool = !!usa_acp;
    const usaExameBool = !!usa_exame;
    const pesoTestesNum = parseFloat(peso_testes) || 0;
    const pesoTrabalhosNum = parseFloat(peso_trabalhos) || 0;
    const pesoAcpNum = usaAcpBool ? (parseFloat(peso_acp) || 0) : 0;
    const pesoExameNum = usaExameBool ? (parseFloat(peso_exame) || 0) : 0;

    const somaPesos = pesoTestesNum + pesoTrabalhosNum + pesoAcpNum + pesoExameNum;
    if (Math.round(somaPesos) !== 100) {
      return res.status(400).json({
        success: false,
        message: `A soma dos pesos deve ser 100% (atualmente está em ${somaPesos.toFixed(1)}%)`,
      });
    }

    // Limites de aprovação/exame/dispensa — definidos pelo administrador
    const notaMinimaAprovacaoNum = nota_minima_aprovacao !== undefined ? parseFloat(nota_minima_aprovacao) : VALORES_PADRAO_AVALIACAO.nota_minima_aprovacao;
    const notaMinimaExameNum = nota_minima_exame !== undefined ? parseFloat(nota_minima_exame) : VALORES_PADRAO_AVALIACAO.nota_minima_exame;
    const notaDispensaNum = nota_dispensa !== undefined ? parseFloat(nota_dispensa) : VALORES_PADRAO_AVALIACAO.nota_dispensa;

    if ([notaMinimaAprovacaoNum, notaMinimaExameNum, notaDispensaNum].some((n) => !Number.isFinite(n) || n < 0 || n > 20)) {
      return res.status(400).json({ success: false, message: 'As notas de referência (aprovação, exame, dispensa) devem estar entre 0 e 20' });
    }
    if (notaDispensaNum < notaMinimaExameNum) {
      return res.status(400).json({ success: false, message: 'A nota de dispensa não pode ser menor que a nota mínima para ir a exame' });
    }

    const [configAntiga] = await queryAsync(`SELECT * FROM avaliacao_config WHERE school_id = ?`, [schoolId]);
    const usarToleranciaBool = !!usar_tolerancia_transicao_esg1;

    await queryAsync(
      `
        INSERT INTO avaliacao_config
          (school_id, qtd_testes, qtd_trabalhos, usa_acp, usa_exame, peso_testes, peso_trabalhos, peso_acp, peso_exame,
           nota_minima_aprovacao, nota_minima_exame, nota_dispensa, usar_tolerancia_transicao_esg1, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          qtd_testes = VALUES(qtd_testes),
          qtd_trabalhos = VALUES(qtd_trabalhos),
          usa_acp = VALUES(usa_acp),
          usa_exame = VALUES(usa_exame),
          peso_testes = VALUES(peso_testes),
          peso_trabalhos = VALUES(peso_trabalhos),
          peso_acp = VALUES(peso_acp),
          peso_exame = VALUES(peso_exame),
          nota_minima_aprovacao = VALUES(nota_minima_aprovacao),
          nota_minima_exame = VALUES(nota_minima_exame),
          nota_dispensa = VALUES(nota_dispensa),
          usar_tolerancia_transicao_esg1 = VALUES(usar_tolerancia_transicao_esg1),
          updated_at = NOW()
      `,
      [
        schoolId, qtdTestesNum, qtdTrabalhosNum, usaAcpBool, usaExameBool, pesoTestesNum, pesoTrabalhosNum, pesoAcpNum, pesoExameNum,
        notaMinimaAprovacaoNum, notaMinimaExameNum, notaDispensaNum, usarToleranciaBool,
      ]
    );

    await registrarAuditoria(req, {
      acao: 'configuracao_avaliacao_alterada', entidadeTipo: 'avaliacao_config', entidadeId: schoolId,
      dadosAntigos: configAntiga || null,
      dadosNovos: {
        qtd_testes: qtdTestesNum, qtd_trabalhos: qtdTrabalhosNum, usa_acp: usaAcpBool, usa_exame: usaExameBool,
        peso_testes: pesoTestesNum, peso_trabalhos: pesoTrabalhosNum, peso_acp: pesoAcpNum, peso_exame: pesoExameNum,
        nota_minima_aprovacao: notaMinimaAprovacaoNum, nota_minima_exame: notaMinimaExameNum, nota_dispensa: notaDispensaNum,
        usar_tolerancia_transicao_esg1: usarToleranciaBool,
      },
    });

    res.json({ success: true, message: 'Configuração de avaliação salva com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar configuração de avaliação:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração de avaliação', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CONFIGURAÇÃO DE PPF (Ponto de Perda por Faltas) — número máximo de faltas
 * que um aluno pode acumular antes de ser automaticamente excluído.
 * Definido pelo administrador na área de Gestão de Presenças.
 * ═══════════════════════════════════════════════════════════════════════
 */

// GET: limite de faltas (PPF) configurado para a escola
export const getPresencaConfig = async (req, res) => {
  try {
    await ensurePresencaConfigTableExists();
    const { schoolId } = req.params;

    let rows = await queryAsync(`SELECT * FROM presenca_config WHERE school_id = ? LIMIT 1`, [schoolId]);
    if (rows.length === 0) {
      await queryAsync(
        `INSERT INTO presenca_config (school_id, faltas_max_ppf, created_at, updated_at) VALUES (?, 30, NOW(), NOW())`,
        [schoolId]
      );
      rows = await queryAsync(`SELECT * FROM presenca_config WHERE school_id = ? LIMIT 1`, [schoolId]);
    }

    res.json({ success: true, data: { faltas_max_ppf: rows[0].faltas_max_ppf } });
  } catch (err) {
    console.error('[v0] Erro ao buscar configuração de presença (PPF):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração de presença', error: err.message });
  }
};

// PUT: salva o limite de faltas (PPF) da escola
export const salvarPresencaConfig = async (req, res) => {
  try {
    await ensurePresencaConfigTableExists();
    const { schoolId } = req.params;
    const { faltas_max_ppf } = req.body;

    const faltasNum = parseInt(faltas_max_ppf, 10);
    if (!Number.isFinite(faltasNum) || faltasNum < 1 || faltasNum > 365) {
      return res.status(400).json({ success: false, message: 'O número máximo de faltas (PPF) deve estar entre 1 e 365' });
    }

    await queryAsync(
      `INSERT INTO presenca_config (school_id, faltas_max_ppf, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE faltas_max_ppf = VALUES(faltas_max_ppf), updated_at = NOW()`,
      [schoolId, faltasNum]
    );

    res.json({ success: true, message: 'Limite de faltas (PPF) atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar configuração de presença (PPF):', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração de presença', error: err.message });
  }
};

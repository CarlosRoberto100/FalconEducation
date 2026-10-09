import db from '../config/db.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

const columnExists = async (table, column) => {
  const result = await queryAsync(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return result.length > 0;
};

const indexExists = async (table, indexName) => {
  const result = await queryAsync(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [indexName]);
  return result.length > 0;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SECÇÕES (tracks/opções curriculares dentro de uma classe)
 * ─────────────────────────────────────────────────────────────────────────
 * v94 — Em Moçambique, a partir de uma certa classe (tipicamente 11ª/12ª), a
 * mesma classe divide-se em opções como "Ciências" e "Letras/Humanidades",
 * cada uma com disciplinas diferentes (ex.: Ciências tem Física/Química,
 * Letras tem História/Geografia). Isto é DIFERENTE de simplesmente ter
 * turmas paralelas (8º A, 8º B) — turmas paralelas da mesma classe sempre
 * partilharam o mesmo currículo; uma SECÇÃO muda o currículo em si.
 *
 * Modelo de dados:
 *   • `secoes` — uma secção pertence a UMA classe (school_id, classe_id, nome).
 *   • `turmas.secao_id` — cada turma pode (opcionalmente) pertencer a uma
 *     secção da sua classe. 0 = turma "sem secção" (classes que não usam
 *     secções continuam a funcionar exatamente como antes).
 *   • `class_disciplinas.secao_id` — cada disciplina associada a uma classe
 *     pode ser "comum a todas as secções" (secao_id = 0) ou "só desta secção"
 *     (secao_id = id da secção). Ao resolver as disciplinas de uma turma,
 *     o sistema junta SEMPRE as comuns (0) + as da secção específica da turma.
 *
 * Convenção: usa-se o sentinela `0` em vez de `NULL` para "sem secção", para
 * que a chave única (classe_id, secao_id, disciplina_id) funcione sem as
 * armadilhas de NULL em índices únicos do MySQL (MySQL trata NULL != NULL,
 * o que permitiria duplicados indesejados se NULL fosse o sentinela).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const ensureSecoesTableExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS secoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      classe_id INT NOT NULL,
      nome VARCHAR(100) NOT NULL,
      ativa TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_classe_secao_nome (classe_id, nome),
      KEY idx_school (school_id),
      KEY idx_classe (classe_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// Garante `turmas.secao_id` — chamada a partir de turmaController.js também,
// por isso fica exportada e é idempotente/memoizada tal como as outras.
export const ensureTurmaSecaoColumnExists = memoize(async () => {
  if (!(await columnExists('turmas', 'secao_id'))) {
    await queryAsync(`ALTER TABLE turmas ADD COLUMN secao_id INT NOT NULL DEFAULT 0 AFTER class_id`);
  }
});

// Garante `class_disciplinas.secao_id` + a nova chave única que inclui a
// secção — chamada a partir de curriculoController.js também.
export const ensureClassDisciplinaSecaoColumnExists = memoize(async () => {
  if (!(await columnExists('class_disciplinas', 'secao_id'))) {
    await queryAsync(`ALTER TABLE class_disciplinas ADD COLUMN secao_id INT NOT NULL DEFAULT 0 AFTER classe_id`);
  }
  // A chave única antiga (classe_id, disciplina_id) impediria a mesma
  // disciplina de estar em DUAS secções diferentes da mesma classe — por
  // isso troca-se para (classe_id, secao_id, disciplina_id). Idempotente:
  // só mexe no índice se ainda não tiver sido trocado.
  if (await indexExists('class_disciplinas', 'uniq_classe_disciplina')) {
    await queryAsync(`ALTER TABLE class_disciplinas DROP INDEX uniq_classe_disciplina`);
  }
  if (!(await indexExists('class_disciplinas', 'uniq_classe_secao_disciplina'))) {
    await queryAsync(`ALTER TABLE class_disciplinas ADD UNIQUE KEY uniq_classe_secao_disciplina (classe_id, secao_id, disciplina_id)`);
  }
});

export const ensureTudoSecoes = async () => {
  await ensureSecoesTableExists();
  await ensureTurmaSecaoColumnExists();
  await ensureClassDisciplinaSecaoColumnExists();
};

/**
 * GET /schools/:schoolId/classes/:classeId/secoes
 * Lista as secções de uma classe (só as ativas, por padrão) + quantas
 * turmas e quantas disciplinas específicas cada uma já tem configuradas —
 * ajuda o admin a ver de relance se já preparou tudo antes de usar em
 * renovações.
 */
export const getSecoesDaClasse = async (req, res) => {
  try {
    await ensureTudoSecoes();
    const { schoolId, classeId } = req.params;
    const { incluir_inativas: incluirInativas } = req.query;

    const classeRows = await queryAsync(`SELECT id FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
    if (classeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe não encontrada' });
    }

    const secoes = await queryAsync(
      `
        SELECT
          sec.id, sec.nome, sec.ativa,
          COUNT(DISTINCT t.id) as turmas_count,
          COUNT(DISTINCT cd.disciplina_id) as disciplinas_especificas_count
        FROM secoes sec
        LEFT JOIN turmas t ON t.secao_id = sec.id AND t.school_id = sec.school_id
        LEFT JOIN class_disciplinas cd ON cd.secao_id = sec.id AND cd.classe_id = sec.classe_id
        WHERE sec.school_id = ? AND sec.classe_id = ? ${incluirInativas === 'true' ? '' : 'AND sec.ativa = TRUE'}
        GROUP BY sec.id, sec.nome, sec.ativa
        ORDER BY sec.nome ASC
      `,
      [schoolId, classeId]
    );

    res.json({ success: true, data: secoes });
  } catch (err) {
    console.error('[v0] Erro ao listar secções da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar secções da classe', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/secoes-por-classe
 * Todas as secções de TODAS as classes da escola de uma vez, agrupadas por
 * classe_id — usado no formulário de "Nova Turma" para saber, assim que o
 * admin escolhe a classe, se deve mostrar o seletor de secção (sem precisar
 * de uma chamada extra por classe).
 */
export const getSecoesPorClasseTodas = async (req, res) => {
  try {
    await ensureTudoSecoes();
    const { schoolId } = req.params;

    const secoes = await queryAsync(
      `SELECT id, classe_id, nome FROM secoes WHERE school_id = ? AND ativa = TRUE ORDER BY nome ASC`,
      [schoolId]
    );

    // v144 — inclui quantas turmas já existem em cada secção (contagem
    // simples, sem detalhe de vagas) para o formulário de inscrição poder
    // mostrar essa informação junto de cada botão de secção, tal como já
    // acontecia no seletor de secção da Renovação de Matrícula — mesmo
    // padrão visual em toda a aplicação, ajuda o admin a perceber de
    // imediato se a secção escolhida já tem turma ou se uma nova vai ser
    // criada automaticamente na inscrição.
    const contagens = await queryAsync(
      `SELECT secao_id, COUNT(*) as total FROM turmas WHERE school_id = ? AND secao_id > 0 AND ativa = TRUE GROUP BY secao_id`,
      [schoolId]
    );
    const turmasPorSecaoId = {};
    contagens.forEach((c) => { turmasPorSecaoId[c.secao_id] = c.total; });

    const porClasse = {};
    secoes.forEach((s) => {
      if (!porClasse[s.classe_id]) porClasse[s.classe_id] = [];
      porClasse[s.classe_id].push({ id: s.id, nome: s.nome, turmas_count: turmasPorSecaoId[s.id] || 0 });
    });

    res.json({ success: true, data: porClasse });
  } catch (err) {
    console.error('[v0] Erro ao listar secções por classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar secções por classe', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/classes/:classeId/secoes
 * Body: { nome }
 */
export const createSecao = async (req, res) => {
  try {
    await ensureTudoSecoes();
    const { schoolId, classeId } = req.params;
    const { nome } = req.body;

    const nomeLimpo = String(nome || '').trim();
    if (!nomeLimpo) {
      return res.status(400).json({ success: false, message: 'Nome da secção é obrigatório' });
    }

    const classeRows = await queryAsync(`SELECT id, nome FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
    if (classeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe não encontrada' });
    }

    const existente = await queryAsync(
      `SELECT id FROM secoes WHERE school_id = ? AND classe_id = ? AND nome = ? LIMIT 1`,
      [schoolId, classeId, nomeLimpo]
    );
    if (existente.length > 0) {
      return res.status(409).json({ success: false, message: `Já existe uma secção "${nomeLimpo}" nesta classe` });
    }

    const resultado = await queryAsync(
      `INSERT INTO secoes (school_id, classe_id, nome, ativa, created_at, updated_at) VALUES (?, ?, ?, TRUE, NOW(), NOW())`,
      [schoolId, classeId, nomeLimpo]
    );

    res.status(201).json({
      success: true,
      message: `Secção "${nomeLimpo}" criada em ${classeRows[0].nome}`,
      data: { id: resultado.insertId, nome: nomeLimpo, classe_id: Number(classeId), ativa: true },
    });
  } catch (err) {
    console.error('[v0] Erro ao criar secção:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar secção', error: err.message });
  }
};

/**
 * PUT /schools/:schoolId/secoes/:secaoId
 * Body: { nome?, ativa? }
 */
export const updateSecao = async (req, res) => {
  try {
    await ensureTudoSecoes();
    const { schoolId, secaoId } = req.params;
    const { nome, ativa } = req.body;

    const secaoRows = await queryAsync(`SELECT id, classe_id FROM secoes WHERE id = ? AND school_id = ?`, [secaoId, schoolId]);
    if (secaoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Secção não encontrada' });
    }

    const campos = [];
    const valores = [];
    if (nome !== undefined) {
      const nomeLimpo = String(nome).trim();
      if (!nomeLimpo) return res.status(400).json({ success: false, message: 'Nome da secção não pode ficar vazio' });
      const duplicada = await queryAsync(
        `SELECT id FROM secoes WHERE school_id = ? AND classe_id = ? AND nome = ? AND id != ? LIMIT 1`,
        [schoolId, secaoRows[0].classe_id, nomeLimpo, secaoId]
      );
      if (duplicada.length > 0) return res.status(409).json({ success: false, message: `Já existe uma secção "${nomeLimpo}" nesta classe` });
      campos.push('nome = ?'); valores.push(nomeLimpo);
    }
    if (ativa !== undefined) { campos.push('ativa = ?'); valores.push(!!ativa); }

    if (campos.length === 0) {
      return res.status(400).json({ success: false, message: 'Nada para atualizar' });
    }

    campos.push('updated_at = NOW()');
    await queryAsync(`UPDATE secoes SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, [...valores, secaoId, schoolId]);

    res.json({ success: true, message: 'Secção atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar secção:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar secção', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v99 — OBRIGATORIEDADE DE ESCOLHA DE SECÇÃO
 * ─────────────────────────────────────────────────────────────────────────
 * Até aqui, sempre que a classe de destino (na renovação) tinha secções
 * configuradas, o sistema OBRIGAVA a escolha, sem exceção. Agora a escola
 * pode definir "a partir de que classe" isso é exigido — útil, por exemplo,
 * durante uma transição em que uma classe já tem secções cadastradas mas a
 * escola ainda não quer forçar a escolha nela. Sem configuração (omissão),
 * o comportamento continua o mesmo de sempre: obrigatória sempre que a
 * classe de destino tiver secções.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const ensureSecaoSettingsTableExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS secao_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      classe_minima_obrigatoria INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

/**
 * v100 — TURMA ÚNICA/MISTA POR SECÇÃO
 * ─────────────────────────────────────────────────────────────────────────
 * Realidade comum em escolas moçambicanas pequenas/privadas: a 11ª/12ª
 * classe tem poucos alunos, e não compensa abrir uma turma física separada
 * para cada secção (Ciências, Letras...) — todos ficam na mesma sala,
 * distinguindo-se só pelas disciplinas próprias de cada secção. Por
 * omissão o sistema continua a criar/usar UMA TURMA POR SECÇÃO (como
 * sempre fez); a escola pode ligar este modo para que a turma passe a ser
 * partilhada (turmas.secao_id fica 0 = "sem secção fixa") e a secção real
 * de cada aluno passe a viver em `students.secao_id` (ver
 * `sincronizarSecaoDoAluno`, abaixo) — é essa a fonte usada por notas e
 * pauta/boletim para separar o que é de cada secção dentro da turma mista.
 */
export const ensureTurmaMistaColumnExists = memoize(async () => {
  await ensureSecaoSettingsTableExists();
  if (!(await columnExists('secao_settings', 'turma_unica_mista'))) {
    await queryAsync(`ALTER TABLE secao_settings ADD COLUMN turma_unica_mista TINYINT(1) NOT NULL DEFAULT 0 AFTER classe_minima_obrigatoria`);
  }
});

// v100 — `students.secao_id`: até aqui a secção de um aluno só existia
// indiretamente, através da turma em que ele estava (`turmas.secao_id`).
// Isso funciona bem quando cada secção tem a sua própria turma física, mas
// deixa de fazer sentido em turma mista (uma turma com alunos de mais de
// uma secção) — por isso a secção passa a ser gravada diretamente no
// aluno, tornando-se a fonte única e válida em qualquer um dos dois modos.
export const ensureStudentSecaoColumnExists = memoize(async () => {
  if (!(await columnExists('students', 'secao_id'))) {
    await queryAsync(`ALTER TABLE students ADD COLUMN secao_id INT NOT NULL DEFAULT 0 AFTER turma_id`);
  }
});

export const getSecaoSettings = async (schoolId) => {
  await ensureTurmaMistaColumnExists();
  const rows = await queryAsync(`SELECT classe_minima_obrigatoria, turma_unica_mista FROM secao_settings WHERE school_id = ? LIMIT 1`, [schoolId]);
  return {
    classe_minima_obrigatoria: rows.length > 0 ? rows[0].classe_minima_obrigatoria : null,
    turma_unica_mista: rows.length > 0 ? !!rows[0].turma_unica_mista : false,
  };
};

export const saveSecaoSettings = async (schoolId, classeMinima, turmaUnicaMista) => {
  await ensureTurmaMistaColumnExists();
  const valor = classeMinima === null || classeMinima === undefined || classeMinima === ''
    ? null
    : parseInt(classeMinima, 10);
  if (valor !== null && (Number.isNaN(valor) || valor < 1 || valor > 12)) {
    const erro = new Error('Classe mínima deve ser um número entre 1 e 12, ou vazio para remover a restrição.');
    erro.status = 400;
    throw erro;
  }
  const mista = turmaUnicaMista ? 1 : 0;
  await queryAsync(
    `INSERT INTO secao_settings (school_id, classe_minima_obrigatoria, turma_unica_mista, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE classe_minima_obrigatoria = VALUES(classe_minima_obrigatoria), turma_unica_mista = VALUES(turma_unica_mista), updated_at = NOW()`,
    [schoolId, valor, mista]
  );
  return { classe_minima_obrigatoria: valor, turma_unica_mista: !!mista };
};

/**
 * v100 — Fonte única para gravar a secção efetiva de um aluno. Chamada tanto
 * na inscrição (createStudent) como na renovação (performRenewEnrollment),
 * em modo turma-por-secção ou turma-mista:
 *   • `secaoIdEscolhida` tem sempre prioridade (é a escolha explícita feita
 *     no formulário, a única fonte confiável em turma mista, onde a turma
 *     por si só já não identifica a secção do aluno);
 *   • na ausência dela, cai para `turmas.secao_id` (compatível com o
 *     comportamento histórico de turma-por-secção).
 */
export const sincronizarSecaoDoAluno = async (schoolId, studentId, turmaId, secaoIdEscolhida = null) => {
  await ensureStudentSecaoColumnExists();
  await ensureTurmaSecaoColumnExists();
  let secaoEfetiva = 0;
  if (secaoIdEscolhida !== null && secaoIdEscolhida !== undefined && Number(secaoIdEscolhida) > 0) {
    secaoEfetiva = Number(secaoIdEscolhida);
  } else if (turmaId) {
    const turmaRows = await queryAsync(`SELECT secao_id FROM turmas WHERE id = ? AND school_id = ?`, [turmaId, schoolId]);
    secaoEfetiva = turmaRows[0]?.secao_id || 0;
  }
  await queryAsync(`UPDATE students SET secao_id = ? WHERE id = ? AND school_id = ?`, [secaoEfetiva, studentId, schoolId]);
  return secaoEfetiva;
};

/**
 * Decide se a escolha de secção é OBRIGATÓRIA para uma classe (dado o seu
 * número, ex.: 11 para "11ª Classe"), de acordo com a configuração da
 * escola. Usada tanto na renovação de matrícula como na inscrição de um
 * aluno novo — fonte única, para as duas ficarem sempre coerentes.
 */
export const secaoEhObrigatoriaParaClasse = async (schoolId, classeNumero) => {
  const { classe_minima_obrigatoria: minima } = await getSecaoSettings(schoolId);
  if (minima === null || minima === undefined) return true; // omissão = comportamento histórico
  return Number(classeNumero) >= Number(minima);
};

/** GET /schools/:schoolId/secao-settings */
export const getSecaoSettingsHandler = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const settings = await getSecaoSettings(schoolId);
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error('[v0] Erro ao obter configuração de secções:', err);
    res.status(500).json({ success: false, message: 'Erro ao obter configuração de secções', error: err.message });
  }
};

/** PUT /schools/:schoolId/secao-settings  Body: { classe_minima_obrigatoria, turma_unica_mista? } */
export const updateSecaoSettingsHandler = async (req, res) => {
  try {
    const { schoolId } = req.params;
    // v100 — quando o campo não vem no body (ex.: o formulário só está a
    // mexer na obrigatoriedade), preserva o valor atual de turma_unica_mista
    // em vez de o reiniciar para "desligado" a cada gravação.
    const atual = await getSecaoSettings(schoolId);
    const turmaUnicaMista = req.body?.turma_unica_mista !== undefined ? !!req.body.turma_unica_mista : atual.turma_unica_mista;
    const settings = await saveSecaoSettings(schoolId, req.body?.classe_minima_obrigatoria, turmaUnicaMista);
    res.json({ success: true, message: 'Configuração de secções atualizada com sucesso', data: settings });
  } catch (err) {
    console.error('[v0] Erro ao atualizar configuração de secções:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao atualizar configuração de secções', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/classes/:classeId/secoes/pendentes
 * v100 — MIGRAÇÃO EM MASSA: quando a escola liga a obrigatoriedade de
 * secção numa classe que já tem alunos ativos, esses alunos ficam sem
 * secção definida (`students.secao_id = 0`) até renovarem — o que pode
 * demorar meses. Este endpoint lista esses alunos pendentes de uma vez,
 * para o admin resolver o histórico já, em lote, em vez de aluno a aluno.
 */
export const getAlunosPendentesDeSecao = async (req, res) => {
  try {
    await ensureTudoSecoes();
    await ensureStudentSecaoColumnExists();
    const { schoolId, classeId } = req.params;

    const classeRows = await queryAsync(`SELECT id, nome FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
    if (classeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe não encontrada' });
    }

    const secoes = await queryAsync(
      `SELECT id, nome FROM secoes WHERE school_id = ? AND classe_id = ? AND ativa = TRUE ORDER BY nome ASC`,
      [schoolId, classeId]
    );

    const alunosPendentes = secoes.length > 0
      ? await queryAsync(
          `
            SELECT s.id, s.nome, s.codigo_aluno, t.id as turma_id, t.nome as turma_nome
            FROM students s
            INNER JOIN turmas t ON t.id = s.turma_id
            WHERE s.school_id = ? AND t.class_id = ? AND s.ativo = 1 AND (s.secao_id IS NULL OR s.secao_id = 0)
            ORDER BY s.nome ASC
          `,
          [schoolId, classeId]
        )
      : [];

    res.json({
      success: true,
      data: {
        classe: classeRows[0],
        secoes,
        alunos_pendentes: alunosPendentes,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao listar alunos pendentes de secção:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar alunos pendentes de secção', error: err.message });
  }
};

/**
 * DELETE /schools/:schoolId/secoes/:secaoId
 * Bloqueia a exclusão se já houver turmas associadas (para não "perder" a
 * secção de alunos já matriculados) — a escola deve desativá-la em vez de
 * excluir, ou primeiro mudar essas turmas para outra secção.
 */
export const deleteSecao = async (req, res) => {
  try {
    await ensureTudoSecoes();
    const { schoolId, secaoId } = req.params;

    const secaoRows = await queryAsync(`SELECT id, nome FROM secoes WHERE id = ? AND school_id = ?`, [secaoId, schoolId]);
    if (secaoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Secção não encontrada' });
    }

    const turmasVinculadas = await queryAsync(`SELECT COUNT(*) as total FROM turmas WHERE secao_id = ? AND school_id = ?`, [secaoId, schoolId]);
    if ((turmasVinculadas[0]?.total || 0) > 0) {
      return res.status(409).json({
        success: false,
        message: `Não é possível excluir: ${turmasVinculadas[0].total} turma(s) ainda pertencem a "${secaoRows[0].nome}". Mude essas turmas de secção primeiro, ou desative a secção em vez de excluir.`,
      });
    }

    await queryAsync(`DELETE FROM class_disciplinas WHERE secao_id = ? AND school_id = ?`, [secaoId, schoolId]);
    await queryAsync(`DELETE FROM secoes WHERE id = ? AND school_id = ?`, [secaoId, schoolId]);
    // v100 — nenhum aluno deve ficar apontado para uma secção que já não
    // existe (relevante em turma mista, onde a secção do aluno não vem só
    // da turma); volta ao sentinela 0 = "sem secção".
    await ensureStudentSecaoColumnExists();
    await queryAsync(`UPDATE students SET secao_id = 0 WHERE secao_id = ? AND school_id = ?`, [secaoId, schoolId]);

    res.json({ success: true, message: 'Secção excluída com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao excluir secção:', err);
    res.status(500).json({ success: false, message: 'Erro ao excluir secção', error: err.message });
  }
};

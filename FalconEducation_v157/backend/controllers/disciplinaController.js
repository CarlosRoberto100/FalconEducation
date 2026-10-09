import db from '../config/db.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// Lista padrão de disciplinas usadas no ensino em Moçambique.
// Serve apenas como "seed" inicial: na primeira vez que uma escola acessa
// o catálogo de disciplinas (e ainda não tem nenhuma cadastrada no banco),
// essa lista é inserida automaticamente para não perder o que já existia.
const DISCIPLINAS_PADRAO = [
  'Português', 'Inglês', 'Matemática', 'Ciências Naturais',
  'Estudo do Meio', 'História e Geografia', 'Educação Visual',
  'Educação Física', 'Moral e Cívica', 'Educação Musical',
  'Educação Tecnológica', 'Desenho', 'Trabalhos Manuais',
  'Francês', 'Biologia', 'Física', 'Química', 'Educação Cívica',
  'Tecnologias de Informação', 'Artística', 'Contabilidade',
  'Economia', 'Direito', 'Agronomia', 'Desenho Técnico',
  'Literatura', 'Filosofia', 'Psicologia', 'Estatística', 'Sociologia',
  'Natação', 'Educação Desportiva', 'Xadrez', 'Ginástica',
  'Dança', 'Teatro', 'Artes Plásticas', 'Música Instrumental',
  'Educação Ambiental', 'Saúde Pública', 'Segurança e Higiene',
  'Noções de Direito', 'Empreendedorismo', 'Informática Básica',
];

const seedDisciplinasPadrao = async (schoolId) => {
  const values = DISCIPLINAS_PADRAO.map((nome) => [schoolId, nome, true]);
  await queryAsync(
    `INSERT IGNORE INTO disciplinas (school_id, nome, ativa, created_at, updated_at)
     VALUES ${values.map(() => '(?, ?, ?, NOW(), NOW())').join(', ')}`,
    values.flat()
  );
};

/**
 * GET: Listar disciplinas cadastradas na escola (faz seed automático na 1ª vez)
 */
export const getAllDisciplinas = async (req, res) => {
  try {
    const { schoolId } = req.params;

    const existentes = await queryAsync(
      `SELECT COUNT(*) as total FROM disciplinas WHERE school_id = ?`,
      [schoolId]
    );

    if ((existentes[0]?.total || 0) === 0) {
      await seedDisciplinasPadrao(schoolId);
    }

    const disciplinas = await queryAsync(
      `
        SELECT
          d.id,
          d.nome,
          d.codigo,
          d.descricao,
          d.carga_horaria_semanal,
          d.ativa,
          COUNT(DISTINCT td.teacher_id) as professores_count
        FROM disciplinas d
        LEFT JOIN teacher_disciplines td ON td.disciplina_id = d.id
        WHERE d.school_id = ?
        GROUP BY d.id
        ORDER BY d.nome ASC
      `,
      [schoolId]
    );

    res.json({ success: true, data: disciplinas });
  } catch (err) {
    console.error('[v0] Erro ao listar disciplinas:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, data: [] });
    }
    res.status(500).json({ success: false, message: 'Erro ao listar disciplinas', error: err.message });
  }
};

/**
 * POST: Cadastrar nova disciplina
 */
export const createDisciplina = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { nome, codigo, descricao, carga_horaria_semanal } = req.body;

    const nomeLimpo = String(nome || '').trim();
    if (!nomeLimpo) {
      return res.status(400).json({ success: false, message: 'Nome da disciplina é obrigatório' });
    }

    const existente = await queryAsync(
      `SELECT id FROM disciplinas WHERE school_id = ? AND nome = ? LIMIT 1`,
      [schoolId, nomeLimpo]
    );
    if (existente.length > 0) {
      return res.status(409).json({ success: false, message: 'Já existe uma disciplina com esse nome' });
    }

    const resultado = await queryAsync(
      `INSERT INTO disciplinas (school_id, nome, codigo, descricao, carga_horaria_semanal, ativa, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
      [
        schoolId,
        nomeLimpo,
        codigo || null,
        descricao || null,
        carga_horaria_semanal ? parseInt(carga_horaria_semanal, 10) : null,
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Disciplina cadastrada com sucesso',
      data: {
        id: resultado.insertId,
        nome: nomeLimpo,
        codigo: codigo || null,
        descricao: descricao || null,
        carga_horaria_semanal: carga_horaria_semanal || null,
        ativa: true,
        professores_count: 0,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao cadastrar disciplina:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Disciplina já cadastrada' });
    }
    res.status(500).json({ success: false, message: 'Erro ao cadastrar disciplina', error: err.message });
  }
};

/**
 * DELETE: Remover uma disciplina do catálogo
 * Se a disciplina estiver associada a professores, é necessário confirmar
 * a exclusão passando ?force=true (o front-end pede confirmação ao usuário antes).
 */
export const deleteDisciplina = async (req, res) => {
  try {
    const { schoolId, disciplinaId } = req.params;
    const force = req.query.force === 'true';

    const existentes = await queryAsync(
      `SELECT id FROM disciplinas WHERE id = ? AND school_id = ?`,
      [disciplinaId, schoolId]
    );
    if (existentes.length === 0) {
      return res.status(404).json({ success: false, message: 'Disciplina não encontrada' });
    }

    const vinculo = await queryAsync(
      `SELECT COUNT(DISTINCT teacher_id) as total FROM teacher_disciplines WHERE disciplina_id = ?`,
      [disciplinaId]
    );
    const professoresVinculados = vinculo[0]?.total || 0;

    if (professoresVinculados > 0 && !force) {
      return res.status(409).json({
        success: false,
        message: `Esta disciplina está associada a ${professoresVinculados} professor(es). Confirme a exclusão para remover também essa associação.`,
        professores_count: professoresVinculados,
      });
    }

    // A FK teacher_disciplines.disciplina_id tem ON DELETE CASCADE,
    // então as associações com professores são removidas automaticamente.
    await queryAsync(`DELETE FROM disciplinas WHERE id = ? AND school_id = ?`, [disciplinaId, schoolId]);

    res.json({ success: true, message: 'Disciplina removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover disciplina:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover disciplina', error: err.message });
  }
};

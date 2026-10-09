import db from '../config/db.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

/**
 * GET /schools/:schoolId/search?q=termo
 * Pesquisa global — busca em paralelo por alunos, professores, turmas,
 * pagamentos (pelo nome do aluno) e encarregados, devolvendo tudo agrupado
 * por categoria, como uma pesquisa única (tipo Google).
 */
export const globalSearch = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const termo = String(req.query.q || '').trim();

    if (termo.length < 2) {
      return res.json({ success: true, data: { alunos: [], professores: [], turmas: [], pagamentos: [], encarregados: [] } });
    }
    const like = `%${termo}%`;

    const [alunos, professores, turmas, pagamentos, encarregados] = await Promise.all([
      queryAsync(
        `SELECT id, nome, codigo_aluno, ativo FROM students
         WHERE school_id = ? AND (nome LIKE ? OR codigo_aluno LIKE ? OR email LIKE ?)
         ORDER BY nome ASC LIMIT 6`,
        [schoolId, like, like, like]
      ),
      queryAsync(
        `SELECT id, nome, codigo_professor, ativo FROM teachers
         WHERE school_id = ? AND (nome LIKE ? OR codigo_professor LIKE ? OR email LIKE ?)
         ORDER BY nome ASC LIMIT 6`,
        [schoolId, like, like, like]
      ),
      queryAsync(
        `SELECT id, nome FROM turmas WHERE school_id = ? AND nome LIKE ? ORDER BY nome ASC LIMIT 6`,
        [schoolId, like]
      ),
      queryAsync(
        `SELECT sp.id, sp.student_id, s.nome as aluno_nome, sp.valor_original, sp.multa, sp.status, sp.data_vencimento
         FROM student_payments sp INNER JOIN students s ON s.id = sp.student_id
         WHERE sp.school_id = ? AND s.nome LIKE ?
         ORDER BY sp.data_vencimento DESC LIMIT 6`,
        [schoolId, like]
      ),
      queryAsync(
        `SELECT g.id, g.nome, g.telefone, g.parentesco, g.student_id, s.nome as aluno_nome
         FROM guardians g INNER JOIN students s ON s.id = g.student_id
         WHERE s.school_id = ? AND g.nome LIKE ?
         ORDER BY g.nome ASC LIMIT 6`,
        [schoolId, like]
      ),
    ]);

    res.json({
      success: true,
      data: { alunos, professores, turmas, pagamentos, encarregados },
      total: alunos.length + professores.length + turmas.length + pagamentos.length + encarregados.length,
    });
  } catch (err) {
    console.error('[v0] Erro na pesquisa global:', err);
    res.status(500).json({ success: false, message: 'Erro na pesquisa global', error: err.message });
  }
};

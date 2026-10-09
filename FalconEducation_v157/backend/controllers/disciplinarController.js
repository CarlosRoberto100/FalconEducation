import db from '../config/db.js';
import { resolverAnoLetivoPorData } from './academicYearController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

export const ensureTabela = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS ocorrencias_disciplinares (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      tipo ENUM('advertencia', 'suspensao', 'elogio') NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      data_ocorrencia DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Ano letivo (ver academicYearController.js) a que a ocorrência pertence —
  // permite, por exemplo, ver só as ocorrências disciplinares do aluno em
  // 2026, separadas do que aconteceu em 2025.
  const coluna = await queryAsync(`SHOW COLUMNS FROM ocorrencias_disciplinares LIKE 'academic_year_id'`);
  if (coluna.length === 0) {
    await queryAsync(`ALTER TABLE ocorrencias_disciplinares ADD COLUMN academic_year_id INT NULL AFTER data_ocorrencia`);
  }
};

// GET /schools/:schoolId/students/:studentId/disciplinar
export const getOcorrenciasDisciplinares = async (req, res) => {
  try {
    await ensureTabela();
    const { schoolId, studentId } = req.params;
    const { academic_year_id } = req.query;
    const ocorrencias = await queryAsync(
      `SELECT * FROM ocorrencias_disciplinares WHERE school_id = ? AND student_id = ? ${academic_year_id ? 'AND academic_year_id = ?' : ''} ORDER BY data_ocorrencia DESC`,
      academic_year_id ? [schoolId, studentId, academic_year_id] : [schoolId, studentId]
    );
    res.json({ success: true, data: ocorrencias });
  } catch (err) {
    console.error('[v0] Erro ao listar ocorrências disciplinares:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar ocorrências disciplinares', error: err.message });
  }
};

// POST /schools/:schoolId/students/:studentId/disciplinar
export const createOcorrenciaDisciplinar = async (req, res) => {
  try {
    await ensureTabela();
    const { schoolId, studentId } = req.params;
    const { tipo, titulo, descricao, data_ocorrencia } = req.body;

    if (!['advertencia', 'suspensao', 'elogio'].includes(tipo)) {
      return res.status(400).json({ success: false, message: 'Tipo deve ser advertencia, suspensao ou elogio' });
    }
    if (!titulo?.trim() || !data_ocorrencia) {
      return res.status(400).json({ success: false, message: 'Título e data são obrigatórios' });
    }

    const anoLetivo = await resolverAnoLetivoPorData(schoolId, data_ocorrencia);
    const inserida = await queryAsync(
      `INSERT INTO ocorrencias_disciplinares (school_id, student_id, tipo, titulo, descricao, data_ocorrencia, academic_year_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, studentId, tipo, titulo.trim(), descricao || null, data_ocorrencia, anoLetivo.virtual ? null : anoLetivo.id]
    );
    res.status(201).json({ success: true, message: 'Ocorrência registada com sucesso', id: inserida.insertId });
  } catch (err) {
    console.error('[v0] Erro ao registar ocorrência disciplinar:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar ocorrência disciplinar', error: err.message });
  }
};

// DELETE /schools/:schoolId/disciplinar/:ocorrenciaId
export const deleteOcorrenciaDisciplinar = async (req, res) => {
  try {
    await ensureTabela();
    const { schoolId, ocorrenciaId } = req.params;
    const resultado = await queryAsync(`DELETE FROM ocorrencias_disciplinares WHERE id = ? AND school_id = ?`, [ocorrenciaId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Ocorrência não encontrada' });
    res.json({ success: true, message: 'Ocorrência removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover ocorrência disciplinar:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover ocorrência disciplinar', error: err.message });
  }
};

import db from '../config/db.js';
import { criarNotificacao } from './notificationController.js';
import { resolverAnoLetivoPorData } from './academicYearController.js';
import { getFaltasMaxPPF } from './gradeController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const STATUS_VALIDOS = ['presente', 'falta', 'atraso', 'justificada'];

/**
 * Garante que a tabela de presenças existe (mesmo padrão usado no
 * studentController para a coluna password: criação automática e segura).
 */
export const ensurePresencasTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS presencas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      turma_id INT NULL,
      data DATE NOT NULL,
      status ENUM('presente','falta','atraso','justificada') NOT NULL DEFAULT 'presente',
      observacao VARCHAR(255) NULL,
      registrado_por INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_aluno_dia (student_id, data),
      KEY idx_school_turma_data (school_id, turma_id, data),
      KEY idx_student (student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Ano letivo (ver academicYearController.js) a que esta presença pertence —
  // resolvido a partir da data no momento do registo, para permitir consultar
  // "a frequência do aluno em 2025" separadamente de "em 2026", em vez de
  // misturar tudo num histórico único indistinto.
  const coluna = await queryAsync(`SHOW COLUMNS FROM presencas LIKE 'academic_year_id'`);
  if (coluna.length === 0) {
    await queryAsync(`ALTER TABLE presencas ADD COLUMN academic_year_id INT NULL AFTER data`);
  }
};

/**
 * GET /schools/:schoolId/turmas/:turmaId/attendance?data=YYYY-MM-DD
 * Lista todos os alunos ativos da turma com o respetivo estado de
 * presença nessa data (null se ainda não foi marcado).
 */
export const getAttendanceByTurmaAndDate = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId, turmaId } = req.params;
    const data = req.query.data || new Date().toISOString().split('T')[0];

    const alunos = await queryAsync(
      `
        SELECT
          s.id AS student_id,
          s.nome,
          s.codigo_aluno,
          p.id AS presenca_id,
          p.status,
          p.observacao
        FROM students s
        LEFT JOIN presencas p
          ON p.student_id = s.id AND p.data = ?
        WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1
        ORDER BY s.nome ASC
      `,
      [data, schoolId, turmaId]
    );

    res.json({ success: true, data: alunos, meta: { data, turmaId: Number(turmaId) } });
  } catch (err) {
    console.error('[v0] Erro ao carregar presença da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar presença', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/turmas/:turmaId/attendance
 * Body: { data: 'YYYY-MM-DD', registros: [{ student_id, status, observacao }] }
 * Regista (ou atualiza, caso já exista) a presença de vários alunos de
 * uma só vez para o mesmo dia.
 */
export const saveAttendanceBulk = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId, turmaId } = req.params;
    const { data, registros } = req.body;
    const registradoPor = req.user?.id || null;

    if (!data) {
      return res.status(400).json({ success: false, message: 'Informe a data da chamada' });
    }
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum registo de presença foi enviado' });
    }
    for (const r of registros) {
      if (!r.student_id || !STATUS_VALIDOS.includes(r.status)) {
        return res.status(400).json({ success: false, message: `Registo inválido para o aluno ${r.student_id}` });
      }
    }

    const anoLetivo = await resolverAnoLetivoPorData(schoolId, data);
    for (const r of registros) {
      await queryAsync(
        `
          INSERT INTO presencas (school_id, student_id, turma_id, data, academic_year_id, status, observacao, registrado_por)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            observacao = VALUES(observacao),
            turma_id = VALUES(turma_id),
            academic_year_id = VALUES(academic_year_id),
            registrado_por = VALUES(registrado_por),
            updated_at = NOW()
        `,
        [schoolId, r.student_id, turmaId, data, anoLetivo.virtual ? null : anoLetivo.id, r.status, r.observacao || null, registradoPor]
      );
    }

    // Notifica o administrador quando um aluno atinge um múltiplo de 5 faltas
    // (5, 10, 15...) — um sinal de alerta sem inundar o painel a cada falta isolada.
    try {
      const alunosComFalta = [...new Set(registros.filter((r) => r.status === 'falta').map((r) => r.student_id))];
      for (const alunoId of alunosComFalta) {
        const [linha] = await queryAsync(
          `SELECT COUNT(*) as total FROM presencas WHERE school_id = ? AND student_id = ? AND status = 'falta'`,
          [schoolId, alunoId]
        );
        const totalFaltas = linha?.total || 0;
        if (totalFaltas > 0 && totalFaltas % 5 === 0) {
          const [aluno] = await queryAsync(`SELECT nome FROM students WHERE id = ? AND school_id = ?`, [alunoId, schoolId]);
          await criarNotificacao(
            schoolId,
            'faltas',
            'Aluno com muitas faltas',
            `${aluno?.nome || 'Aluno'} já acumula ${totalFaltas} falta(s).`
          );
        }
      }
    } catch (erroNotif) {
      console.error('[v0] Aviso: não foi possível verificar notificações de faltas:', erroNotif.message);
    }

    res.json({ success: true, message: `Presença registada para ${registros.length} aluno(s) em ${data}.` });
  } catch (err) {
    console.error('[v0] Erro ao registar presença em massa:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar presença', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/students/bulk-attendance
 * Marca o mesmo estado de presença (falta/presente/atraso/justificada) para
 * uma lista de alunos escolhidos livremente na aba Alunos — ao contrário de
 * saveAttendanceBulk (que assume todos os alunos de UMA turma), aqui os
 * alunos podem pertencer a turmas diferentes; a turma de cada registo é
 * sempre a turma atual do próprio aluno.
 */
export const bulkMarkAttendance = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId } = req.params;
    const { studentIds, data, status, observacao } = req.body;
    const registradoPor = req.user?.id || null;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione pelo menos um aluno' });
    }
    if (!data) {
      return res.status(400).json({ success: false, message: 'Informe a data' });
    }
    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ success: false, message: 'Estado de presença inválido' });
    }

    const placeholders = studentIds.map(() => '?').join(',');
    const alunos = await queryAsync(
      `SELECT id, turma_id FROM students WHERE school_id = ? AND id IN (${placeholders})`,
      [schoolId, ...studentIds]
    );

    let atualizados = 0;
    const anoLetivo = await resolverAnoLetivoPorData(schoolId, data);
    for (const aluno of alunos) {
      try {
        await queryAsync(
          `
            INSERT INTO presencas (school_id, student_id, turma_id, data, academic_year_id, status, observacao, registrado_por)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              status = VALUES(status),
              observacao = VALUES(observacao),
              turma_id = VALUES(turma_id),
              academic_year_id = VALUES(academic_year_id),
              registrado_por = VALUES(registrado_por),
              updated_at = NOW()
          `,
          [schoolId, aluno.id, aluno.turma_id, data, anoLetivo.virtual ? null : anoLetivo.id, status, observacao || null, registradoPor]
        );
        atualizados += 1;
      } catch (erroAluno) {
        console.error(`[v0] Erro ao marcar presença em massa para aluno #${aluno.id}:`, erroAluno.message);
      }
    }

    res.json({ success: true, message: `Presença ("${status}") registada para ${atualizados} de ${studentIds.length} aluno(s) selecionado(s) em ${data}.` });
  } catch (err) {
    console.error('[v0] Erro ao marcar presença em massa:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar presença em massa', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/students/:studentId/attendance?mes=YYYY-MM
 * Histórico de presença de um aluno + estatísticas de frequência.
 */
// Calcula as estatísticas de frequência de um aluno a partir dos registos de
// presença. Extraída como função reutilizável para que qualquer módulo (perfil
// do aluno, motor de situação escolar, etc.) leia a frequência exatamente da
// mesma forma que o endpoint de histórico de presença.
export const calcularFrequenciaAluno = async (schoolId, studentId, { mes, academicYearId } = {}) => {
  await ensurePresencasTableExists();

  let query = `SELECT id, data, status, observacao, created_at FROM presencas WHERE school_id = ? AND student_id = ?`;
  const params = [schoolId, studentId];

  if (mes) {
    query += ` AND DATE_FORMAT(data, '%Y-%m') = ?`;
    params.push(mes);
  }
  if (academicYearId) {
    query += ` AND academic_year_id = ?`;
    params.push(academicYearId);
  }
  query += ` ORDER BY data DESC LIMIT 200`;

  const registros = await queryAsync(query, params);

  const total = registros.length;
  const presentes = registros.filter((r) => r.status === 'presente').length;
  const faltas = registros.filter((r) => r.status === 'falta').length;
  const atrasos = registros.filter((r) => r.status === 'atraso').length;
  const justificadas = registros.filter((r) => r.status === 'justificada').length;
  // Atrasos contam como 0.5 falta para efeitos de percentual, e faltas justificadas não penalizam.
  const diasComputaveis = total - justificadas;
  const percentualFrequencia = diasComputaveis > 0
    ? Number((((presentes + atrasos * 0.5) / diasComputaveis) * 100).toFixed(1))
    : 100;

  // ── PPF / RISCO DE EXCLUSÃO ─────────────────────────────────────────────
  // O total de faltas para efeitos de PPF NÃO é limitado aos últimos 200
  // registos (histórico completo, mesmo critério usado pelo motor de
  // renovação em renewalController.js), para não subestimar o risco de um
  // aluno com muitos anos de histórico.
  const faltasMaxPPF = await getFaltasMaxPPF(schoolId);
  let totalFaltasHistorico = faltas;
  if (total >= 200) {
    // só refaz a contagem sem limite quando os 200 registos mais recentes já
    // esgotaram a página, para poupar uma consulta extra no caso comum
    const semLimite = await queryAsync(
      `SELECT COUNT(*) as total FROM presencas WHERE school_id = ? AND student_id = ? AND status = 'falta'${academicYearId ? ' AND academic_year_id = ?' : ''}`,
      academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
    );
    totalFaltasHistorico = semLimite[0]?.total || faltas;
  }
  const percentualParaExclusao = faltasMaxPPF > 0 ? Number(((totalFaltasHistorico / faltasMaxPPF) * 100).toFixed(0)) : 0;
  const riscoExclusao = totalFaltasHistorico >= faltasMaxPPF
    ? 'excluido'
    : percentualParaExclusao >= 80
      ? 'critico'
      : percentualParaExclusao >= 60
        ? 'atencao'
        : 'baixo';

  return {
    registros,
    stats: {
      total, presentes, faltas, atrasos, justificadas, percentualFrequencia,
      faltas_max_ppf: faltasMaxPPF,
      total_faltas_ppf: totalFaltasHistorico,
      risco_exclusao: riscoExclusao,
    },
  };
};

export const getStudentAttendance = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { mes, academic_year_id } = req.query;

    const { registros, stats } = await calcularFrequenciaAluno(schoolId, studentId, { mes, academicYearId: academic_year_id });

    res.json({
      success: true,
      data: registros,
      stats,
    });
  } catch (err) {
    console.error('[v0] Erro ao carregar histórico de presença do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar histórico de presença', error: err.message });
  }
};

/**
 * Busca (e cria com valor padrão, se necessário) o limite de faltas (PPF)
 * da escola, configurado pelo administrador.
 * NOTA: reaproveita a mesma função exportada em gradeController.js (ver
 * import acima) — extraída para lá porque também é usada pelo motor de
 * situação académica (renewalController.js). Mantida aqui só como
 * referência do que este ficheiro consome.
 */

/**
 * GET /schools/:schoolId/turmas/:turmaId/faltas-resumo
 * Área de gestão dos administradores: lista todos os alunos de uma turma
 * com o total de faltas, atrasos e justificadas, e sinaliza quem já atingiu
 * (ou está perto de atingir) o limite de faltas (PPF) definido pelo admin.
 * Diferente da "chamada" feita em sala de aula — aqui o foco é a gestão/
 * correção dos registos já lançados pelos professores.
 */
export const getResumoFaltasTurma = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId, turmaId } = req.params;
    const { academic_year_id } = req.query;

    const faltasMaxPPF = await getFaltasMaxPPF(schoolId);

    const alunos = await queryAsync(
      `
        SELECT
          s.id AS student_id,
          s.nome,
          s.codigo_aluno,
          COALESCE(SUM(CASE WHEN p.status = 'falta' THEN 1 ELSE 0 END), 0) AS total_faltas,
          COALESCE(SUM(CASE WHEN p.status = 'atraso' THEN 1 ELSE 0 END), 0) AS total_atrasos,
          COALESCE(SUM(CASE WHEN p.status = 'justificada' THEN 1 ELSE 0 END), 0) AS total_justificadas,
          COALESCE(SUM(CASE WHEN p.status = 'presente' THEN 1 ELSE 0 END), 0) AS total_presencas
        FROM students s
        LEFT JOIN presencas p ON p.student_id = s.id AND p.school_id = s.school_id
          ${academic_year_id ? 'AND p.academic_year_id = ?' : ''}
        WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1
        GROUP BY s.id, s.nome, s.codigo_aluno
        ORDER BY s.nome ASC
      `,
      academic_year_id ? [academic_year_id, schoolId, turmaId] : [schoolId, turmaId]
    );

    const data = alunos.map((a) => {
      const totalFaltas = Number(a.total_faltas) || 0;
      const excluidoPorFaltas = totalFaltas >= faltasMaxPPF;
      const emAlerta = !excluidoPorFaltas && totalFaltas >= Math.ceil(faltasMaxPPF * 0.8);
      return {
        ...a,
        total_faltas: totalFaltas,
        total_atrasos: Number(a.total_atrasos) || 0,
        total_justificadas: Number(a.total_justificadas) || 0,
        total_presencas: Number(a.total_presencas) || 0,
        faltas_restantes: Math.max(faltasMaxPPF - totalFaltas, 0),
        excluido_por_faltas: excluidoPorFaltas,
        em_alerta: emAlerta,
      };
    });

    res.json({ success: true, data, faltas_max_ppf: faltasMaxPPF, meta: { turmaId: Number(turmaId) } });
  } catch (err) {
    console.error('[v0] Erro ao carregar resumo de faltas da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar resumo de faltas', error: err.message });
  }
};

/**
 * PUT /schools/:schoolId/attendance/:id
 * Corrige um registo de presença já lançado.
 */
export const updateAttendanceRecord = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId, id } = req.params;
    const { status, observacao } = req.body;

    if (status && !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status de presença inválido' });
    }

    const existente = await queryAsync(`SELECT id FROM presencas WHERE id = ? AND school_id = ?`, [id, schoolId]);
    if (existente.length === 0) {
      return res.status(404).json({ success: false, message: 'Registo de presença não encontrado' });
    }

    const campos = [];
    const valores = [];
    if (status !== undefined) { campos.push('status = ?'); valores.push(status); }
    if (observacao !== undefined) { campos.push('observacao = ?'); valores.push(observacao); }
    if (campos.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum campo para atualizar' });
    }
    campos.push('updated_at = NOW()');
    valores.push(id, schoolId);

    await queryAsync(`UPDATE presencas SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);
    res.json({ success: true, message: 'Registo de presença atualizado' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar presença:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar presença', error: err.message });
  }
};

/**
 * DELETE /schools/:schoolId/attendance/:id
 */
export const deleteAttendanceRecord = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const { schoolId, id } = req.params;

    const existente = await queryAsync(`SELECT id FROM presencas WHERE id = ? AND school_id = ?`, [id, schoolId]);
    if (existente.length === 0) {
      return res.status(404).json({ success: false, message: 'Registo de presença não encontrado' });
    }

    await queryAsync(`DELETE FROM presencas WHERE id = ? AND school_id = ?`, [id, schoolId]);
    res.json({ success: true, message: 'Registo de presença removido' });
  } catch (err) {
    console.error('[v0] Erro ao remover presença:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover presença', error: err.message });
  }
};

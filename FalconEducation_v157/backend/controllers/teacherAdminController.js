import db from '../config/db.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const columnExists = async (tabela, coluna) => {
  const rows = await queryAsync(
    `SELECT COUNT(*) as qtd FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tabela, coluna]
  );
  return rows[0]?.qtd > 0;
};

const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

export const TIPOS_CONTRATO_VALIDOS = ['efetivo', 'temporario', 'prestacao_servicos', 'estagio'];
const ESTADOS_CONTRATO_VALIDOS = ['ativo', 'licenca', 'suspenso', 'rescindido'];
const TIPOS_FALTA_VALIDOS = ['falta', 'falta_justificada', 'atraso'];
const TIPOS_DESEMPENHO_VALIDOS = ['elogio', 'advertencia', 'avaliacao', 'observacao'];

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRAÇÃO — "PERFIL ADMINISTRATIVO DO PROFESSOR". Tudo idempotente (ALTER/
// CREATE ... IF NOT EXISTS), para não quebrar bases já existentes.
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureTeachersColunasAdministrativas = memoize(async () => {
  const colunas = [
    ['carga_horaria_semanal', `ALTER TABLE teachers ADD COLUMN carga_horaria_semanal INT NULL COMMENT 'Carga horária prevista, em horas/semana' AFTER salario`],
    ['tipo_contrato', `ALTER TABLE teachers ADD COLUMN tipo_contrato VARCHAR(30) NULL AFTER carga_horaria_semanal`],
    ['estado_contrato', `ALTER TABLE teachers ADD COLUMN estado_contrato VARCHAR(20) NOT NULL DEFAULT 'ativo' AFTER tipo_contrato`],
    ['data_inicio_contrato', `ALTER TABLE teachers ADD COLUMN data_inicio_contrato DATE NULL AFTER estado_contrato`],
    ['data_fim_contrato', `ALTER TABLE teachers ADD COLUMN data_fim_contrato DATE NULL AFTER data_inicio_contrato`],
  ];
  for (const [coluna, sql] of colunas) {
    if (!(await columnExists('teachers', coluna))) await queryAsync(sql);
  }
});

const ensureTeacherLogsTables = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS teacher_attendance_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      data DATE NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'falta',
      observacao TEXT NULL,
      registrado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_teacher (school_id, teacher_id),
      KEY idx_data (data)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS teacher_performance_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      data DATE NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'observacao',
      nota DECIMAL(4,2) NULL COMMENT 'Nota opcional de 0 a 10, para avaliações formais',
      titulo VARCHAR(150) NOT NULL,
      descricao TEXT NULL,
      registrado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_teacher (school_id, teacher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

export const ensureTudo = async () => {
  await ensureTeachersColunasAdministrativas();
  await ensureTeacherLogsTables();
};

// ═══════════════════════════════════════════════════════════════════════════════
// CARGA HORÁRIA — "Carga prevista: 24h · Carga atual: 22h · Turmas: 4 ·
// Disciplinas: 3 · Horários: 18", tudo calculado a partir de dados reais.
// Cada linha ativa em `horarios` conta como 1 hora/semana (1 aula = 1 slot).
// ═══════════════════════════════════════════════════════════════════════════════
export const getCargaHorariaProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;

    const [professor] = await queryAsync(
      `SELECT id, nome, carga_horaria_semanal FROM teachers WHERE id = ? AND school_id = ?`,
      [teacherId, schoolId]
    );
    if (!professor) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    const [resumo] = await queryAsync(
      `
        SELECT
          COUNT(*) as total_horarios,
          COUNT(DISTINCT turma_id) as total_turmas,
          COUNT(DISTINCT disciplina_id) as total_disciplinas
        FROM horarios
        WHERE school_id = ? AND teacher_id = ? AND ativo = 1
      `,
      [schoolId, teacherId]
    );

    const cargaAtual = resumo?.total_horarios || 0;
    const cargaPrevista = professor.carga_horaria_semanal;

    // Distribuição por turma — útil para o admin ver onde o professor está
    // sobrecarregado ou com folga.
    const distribuicao = await queryAsync(
      `
        SELECT t.id as turma_id, t.nome as turma_nome, d.nome as disciplina_nome, COUNT(*) as horas
        FROM horarios h
        LEFT JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN disciplinas d ON d.id = h.disciplina_id
        WHERE h.school_id = ? AND h.teacher_id = ? AND h.ativo = 1
        GROUP BY t.id, t.nome, d.id, d.nome
        ORDER BY t.nome ASC
      `,
      [schoolId, teacherId]
    );

    res.json({
      success: true,
      professor_nome: professor.nome,
      carga_prevista: cargaPrevista,
      carga_atual: cargaAtual,
      diferenca: cargaPrevista != null ? cargaAtual - cargaPrevista : null,
      total_turmas: resumo?.total_turmas || 0,
      total_disciplinas: resumo?.total_disciplinas || 0,
      total_horarios: cargaAtual,
      distribuicao,
    });
  } catch (err) {
    console.error('[v0] Erro ao calcular carga horária do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular carga horária do professor', error: err.message });
  }
};

// GET /schools/:schoolId/teachers/carga-horaria — visão da escola inteira
// (usada na listagem de professores, para mostrar a carga de todos de uma vez).
export const getCargaHorariaEscola = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId } = req.params;
    const linhas = await queryAsync(
      `
        SELECT
          te.id as teacher_id, te.carga_horaria_semanal as carga_prevista,
          COUNT(h.id) as carga_atual,
          COUNT(DISTINCT h.turma_id) as total_turmas,
          COUNT(DISTINCT h.disciplina_id) as total_disciplinas
        FROM teachers te
        LEFT JOIN horarios h ON h.teacher_id = te.id AND h.ativo = 1 AND h.school_id = te.school_id
        WHERE te.school_id = ? AND te.ativo = 1
        GROUP BY te.id, te.carga_horaria_semanal
      `,
      [schoolId]
    );
    res.json({ success: true, data: linhas });
  } catch (err) {
    console.error('[v0] Erro ao calcular carga horária da escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular carga horária da escola', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRATO — tipo, estado, vigência, carga prevista, salário (o salário já
// existia; aqui só passamos a permitir editá-lo junto com os campos novos).
// ═══════════════════════════════════════════════════════════════════════════════
export const atualizarContratoProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;
    const { carga_horaria_semanal, tipo_contrato, estado_contrato, data_inicio_contrato, data_fim_contrato, salario } = req.body;

    const [professor] = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ?`, [teacherId, schoolId]);
    if (!professor) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    if (tipo_contrato !== undefined && tipo_contrato !== null && tipo_contrato !== '' && !TIPOS_CONTRATO_VALIDOS.includes(tipo_contrato)) {
      return res.status(400).json({ success: false, message: `Tipo de contrato inválido. Use um de: ${TIPOS_CONTRATO_VALIDOS.join(', ')}` });
    }
    if (estado_contrato !== undefined && !ESTADOS_CONTRATO_VALIDOS.includes(estado_contrato)) {
      return res.status(400).json({ success: false, message: `Estado de contrato inválido. Use um de: ${ESTADOS_CONTRATO_VALIDOS.join(', ')}` });
    }

    const campos = [];
    const valores = [];
    if (carga_horaria_semanal !== undefined) { campos.push('carga_horaria_semanal = ?'); valores.push(carga_horaria_semanal === '' ? null : carga_horaria_semanal); }
    if (tipo_contrato !== undefined) { campos.push('tipo_contrato = ?'); valores.push(tipo_contrato || null); }
    if (estado_contrato !== undefined) { campos.push('estado_contrato = ?'); valores.push(estado_contrato); }
    if (data_inicio_contrato !== undefined) { campos.push('data_inicio_contrato = ?'); valores.push(data_inicio_contrato || null); }
    if (data_fim_contrato !== undefined) { campos.push('data_fim_contrato = ?'); valores.push(data_fim_contrato || null); }
    if (salario !== undefined) { campos.push('salario = ?'); valores.push(salario === '' ? null : salario); }

    if (campos.length === 0) return res.status(400).json({ success: false, message: 'Nada para atualizar' });

    valores.push(teacherId, schoolId);
    await queryAsync(`UPDATE teachers SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);
    res.json({ success: true, message: 'Contrato atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar contrato do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar contrato do professor', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FALTAS / ATRASOS
// ═══════════════════════════════════════════════════════════════════════════════
export const getFaltasProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;
    const registros = await queryAsync(
      `SELECT * FROM teacher_attendance_log WHERE school_id = ? AND teacher_id = ? ORDER BY data DESC, id DESC`,
      [schoolId, teacherId]
    );
    const faltas = registros.filter((r) => r.tipo === 'falta').length;
    const faltasJustificadas = registros.filter((r) => r.tipo === 'falta_justificada').length;
    const atrasos = registros.filter((r) => r.tipo === 'atraso').length;
    res.json({ success: true, data: registros, resumo: { faltas, faltas_justificadas: faltasJustificadas, atrasos } });
  } catch (err) {
    console.error('[v0] Erro ao listar faltas do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar faltas do professor', error: err.message });
  }
};

export const registarFaltaProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;
    const { data, tipo, observacao } = req.body;

    if (!data) return res.status(400).json({ success: false, message: 'Indique a data' });
    const tipoFinal = TIPOS_FALTA_VALIDOS.includes(tipo) ? tipo : 'falta';

    const [professor] = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ?`, [teacherId, schoolId]);
    if (!professor) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    const inserido = await queryAsync(
      `INSERT INTO teacher_attendance_log (school_id, teacher_id, data, tipo, observacao, registrado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, teacherId, data, tipoFinal, observacao || null, req.user?.nome || req.user?.email || null]
    );
    res.status(201).json({ success: true, message: 'Registo adicionado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao registar falta do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar falta do professor', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/professores-faltas/bulk
 * Body: { data: 'YYYY-MM-DD', registros: [{ teacher_id, tipo, observacao }] }
 *
 * v85 — Marcação de faltas dos professores mais acessível: em vez de o
 * admin ter de abrir o Perfil de CADA professor individualmente (aba
 * "Faltas/Atrasos") para registar uma falta de cada vez, esta rota permite
 * marcar TODO o corpo docente de uma vez, numa única tela, para um dia —
 * o mesmo padrão de "chamada" já usado para os alunos (ver
 * attendanceController.js#saveAttendanceBulk), adaptado à regra de negócio
 * dos professores: só se grava um registo quando o tipo é realmente uma
 * ausência (falta/atraso/falta_justificada) — um professor "presente" não
 * gera linha nenhuma na tabela, exatamente como já acontecia no registo
 * individual (registarFaltaProfessor nunca teve conceito de "presente").
 */
export const registarFaltasProfessoresBulk = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId } = req.params;
    const { data, registros } = req.body;

    if (!data) return res.status(400).json({ success: false, message: 'Indique a data' });
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum registo foi enviado' });
    }

    // Só processa entradas com um tipo de ausência válido — permite que o
    // frontend envie a lista COMPLETA de professores (incluindo os
    // marcados como "presente", sem tipo), e aqui filtramos silenciosamente
    // os que não geram registo, em vez de rejeitar o pedido inteiro.
    const paraGravar = registros.filter((r) => r.teacher_id && TIPOS_FALTA_VALIDOS.includes(r.tipo));
    if (paraGravar.length === 0) {
      return res.json({ success: true, message: 'Nenhuma ausência para registar — todos marcados como presentes.', total: 0 });
    }

    const idsProfessores = paraGravar.map((r) => r.teacher_id);
    const professoresValidos = await queryAsync(
      `SELECT id FROM teachers WHERE school_id = ? AND id IN (${idsProfessores.map(() => '?').join(',')})`,
      [schoolId, ...idsProfessores]
    );
    const idsValidosSet = new Set(professoresValidos.map((p) => p.id));

    const registradoPor = req.user?.nome || req.user?.email || null;
    let gravados = 0;
    const ignorados = [];
    for (const r of paraGravar) {
      if (!idsValidosSet.has(r.teacher_id)) { ignorados.push(r.teacher_id); continue; }
      await queryAsync(
        `INSERT INTO teacher_attendance_log (school_id, teacher_id, data, tipo, observacao, registrado_por, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [schoolId, r.teacher_id, data, r.tipo, r.observacao || null, registradoPor]
      );
      gravados += 1;
    }

    res.json({
      success: true,
      message: `${gravados} registo(s) de ausência lançado(s) para ${data}.${ignorados.length ? ` ${ignorados.length} professor(es) inválido(s) ignorado(s).` : ''}`,
      total: gravados,
    });
  } catch (err) {
    console.error('[v0] Erro ao registar faltas em massa dos professores:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar faltas em massa', error: err.message });
  }
};

export const removerFaltaProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, registoId } = req.params;
    await queryAsync(`DELETE FROM teacher_attendance_log WHERE id = ? AND school_id = ?`, [registoId, schoolId]);
    res.json({ success: true, message: 'Registo removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover registo de falta do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover registo de falta do professor', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DESEMPENHO ADMINISTRATIVO — elogios, advertências, avaliações e observações
// lançadas pela direção (não é auto-avaliação do professor nem nota de aluno).
// ═══════════════════════════════════════════════════════════════════════════════
export const getDesempenhoProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;
    const registros = await queryAsync(
      `SELECT * FROM teacher_performance_log WHERE school_id = ? AND teacher_id = ? ORDER BY data DESC, id DESC`,
      [schoolId, teacherId]
    );
    const notas = registros.filter((r) => r.nota != null).map((r) => parseFloat(r.nota));
    const mediaAvaliacoes = notas.length > 0 ? Number((notas.reduce((s, n) => s + n, 0) / notas.length).toFixed(1)) : null;
    res.json({
      success: true,
      data: registros,
      resumo: {
        elogios: registros.filter((r) => r.tipo === 'elogio').length,
        advertencias: registros.filter((r) => r.tipo === 'advertencia').length,
        avaliacoes: registros.filter((r) => r.tipo === 'avaliacao').length,
        media_avaliacoes: mediaAvaliacoes,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao listar desempenho do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar desempenho do professor', error: err.message });
  }
};

export const registarDesempenhoProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;
    const { data, tipo, nota, titulo, descricao } = req.body;

    if (!titulo?.trim()) return res.status(400).json({ success: false, message: 'Indique um título' });
    const tipoFinal = TIPOS_DESEMPENHO_VALIDOS.includes(tipo) ? tipo : 'observacao';
    if (nota !== undefined && nota !== null && nota !== '' && (Number(nota) < 0 || Number(nota) > 10)) {
      return res.status(400).json({ success: false, message: 'A nota deve estar entre 0 e 10' });
    }

    const [professor] = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ?`, [teacherId, schoolId]);
    if (!professor) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    const inserido = await queryAsync(
      `INSERT INTO teacher_performance_log (school_id, teacher_id, data, tipo, nota, titulo, descricao, registrado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        schoolId, teacherId, data || new Date().toISOString().split('T')[0], tipoFinal,
        nota === '' || nota === undefined ? null : nota, titulo.trim(), descricao || null,
        req.user?.nome || req.user?.email || null,
      ]
    );
    res.status(201).json({ success: true, message: 'Registo adicionado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao registar desempenho do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar desempenho do professor', error: err.message });
  }
};

export const removerDesempenhoProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, registoId } = req.params;
    await queryAsync(`DELETE FROM teacher_performance_log WHERE id = ? AND school_id = ?`, [registoId, schoolId]);
    res.json({ success: true, message: 'Registo removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover registo de desempenho do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover registo de desempenho do professor', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PERFIL ADMINISTRATIVO COMPLETO — um único pedido, agrega tudo (dados
// pessoais já vêm de getTeacherById; aqui só o que é novo).
// ═══════════════════════════════════════════════════════════════════════════════
export const getPerfilAdministrativoProfessor = async (req, res) => {
  try {
    await ensureTudo();
    const { schoolId, teacherId } = req.params;

    const [professor] = await queryAsync(
      `SELECT id, nome, carga_horaria_semanal, tipo_contrato, estado_contrato, data_inicio_contrato, data_fim_contrato, salario, data_admissao
       FROM teachers WHERE id = ? AND school_id = ?`,
      [teacherId, schoolId]
    );
    if (!professor) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    const [resumoCarga] = await queryAsync(
      `SELECT COUNT(*) as total_horarios, COUNT(DISTINCT turma_id) as total_turmas, COUNT(DISTINCT disciplina_id) as total_disciplinas
       FROM horarios WHERE school_id = ? AND teacher_id = ? AND ativo = 1`,
      [schoolId, teacherId]
    );

    const faltas = await queryAsync(
      `SELECT * FROM teacher_attendance_log WHERE school_id = ? AND teacher_id = ? ORDER BY data DESC LIMIT 12`,
      [schoolId, teacherId]
    );
    const desempenho = await queryAsync(
      `SELECT * FROM teacher_performance_log WHERE school_id = ? AND teacher_id = ? ORDER BY data DESC LIMIT 12`,
      [schoolId, teacherId]
    );

    // Timeline combinada — faltas + desempenho, mais recente primeiro.
    const timeline = [
      ...faltas.map((f) => ({ tipo: f.tipo, data: f.data, titulo: f.tipo === 'atraso' ? 'Atraso registado' : f.tipo === 'falta_justificada' ? 'Falta justificada' : 'Falta registada', detalhe: f.observacao })),
      ...desempenho.map((d) => ({ tipo: d.tipo, data: d.data, titulo: d.titulo, detalhe: d.descricao, nota: d.nota })),
    ].sort((a, b) => new Date(b.data) - new Date(a.data)).slice(0, 20);

    res.json({
      success: true,
      contrato: {
        tipo_contrato: professor.tipo_contrato,
        estado_contrato: professor.estado_contrato,
        data_inicio_contrato: professor.data_inicio_contrato,
        data_fim_contrato: professor.data_fim_contrato,
        salario: professor.salario,
        data_admissao: professor.data_admissao,
      },
      carga_horaria: {
        carga_prevista: professor.carga_horaria_semanal,
        carga_atual: resumoCarga?.total_horarios || 0,
        total_turmas: resumoCarga?.total_turmas || 0,
        total_disciplinas: resumoCarga?.total_disciplinas || 0,
      },
      faltas_resumo: {
        faltas: faltas.filter((f) => f.tipo === 'falta').length,
        atrasos: faltas.filter((f) => f.tipo === 'atraso').length,
      },
      desempenho_resumo: {
        elogios: desempenho.filter((d) => d.tipo === 'elogio').length,
        advertencias: desempenho.filter((d) => d.tipo === 'advertencia').length,
      },
      timeline,
    });
  } catch (err) {
    console.error('[v0] Erro ao montar perfil administrativo do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar perfil administrativo do professor', error: err.message });
  }
};

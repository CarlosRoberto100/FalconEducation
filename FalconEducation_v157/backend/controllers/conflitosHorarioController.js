import db from '../config/db.js';
import { ensureTabelasHorario, getOrCreateHorarioConfig, calcularSlotsDoDia } from './horarioController.js';

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

const columnExists = async (tabela, coluna) => {
  const rows = await queryAsync(
    `SELECT COUNT(*) as qtd FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tabela, coluna]
  );
  return rows[0]?.qtd > 0;
};

// ═══════════════════════════════════════════════════════════════════════════════
// DISPONIBILIDADE DO PROFESSOR — conceito novo: o admin marca os
// dia/turno em que um professor NÃO está disponível para lecionar (ex.:
// compromisso externo, outro emprego, etc.). O motor de conflitos cruza isso
// com os horários já atribuídos.
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureTabelaIndisponibilidade = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS teacher_indisponibilidade (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      dia_semana VARCHAR(20) NOT NULL,
      turno_id INT NOT NULL,
      motivo VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_professor_slot (teacher_id, dia_semana, turno_id),
      KEY idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

export const getIndisponibilidadeProfessor = async (req, res) => {
  try {
    await ensureTabelaIndisponibilidade();
    const { schoolId, teacherId } = req.params;
    const registros = await queryAsync(
      `SELECT i.*, tn.nome as turno_nome FROM teacher_indisponibilidade i LEFT JOIN turnos tn ON tn.id = i.turno_id
       WHERE i.school_id = ? AND i.teacher_id = ? ORDER BY i.dia_semana ASC`,
      [schoolId, teacherId]
    );
    res.json({ success: true, data: registros });
  } catch (err) {
    console.error('[v0] Erro ao listar indisponibilidade do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar indisponibilidade do professor', error: err.message });
  }
};

export const criarIndisponibilidadeProfessor = async (req, res) => {
  try {
    await ensureTabelaIndisponibilidade();
    const { schoolId, teacherId } = req.params;
    const { dia_semana, turno_id, motivo } = req.body;
    if (!dia_semana || !turno_id) return res.status(400).json({ success: false, message: 'Indique dia da semana e turno' });

    await queryAsync(
      `INSERT INTO teacher_indisponibilidade (school_id, teacher_id, dia_semana, turno_id, motivo, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE motivo = VALUES(motivo)`,
      [schoolId, teacherId, dia_semana, turno_id, motivo || null]
    );
    res.status(201).json({ success: true, message: 'Indisponibilidade registada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao registar indisponibilidade do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar indisponibilidade do professor', error: err.message });
  }
};

export const removerIndisponibilidadeProfessor = async (req, res) => {
  try {
    await ensureTabelaIndisponibilidade();
    const { schoolId, registoId } = req.params;
    await queryAsync(`DELETE FROM teacher_indisponibilidade WHERE id = ? AND school_id = ?`, [registoId, schoolId]);
    res.json({ success: true, message: 'Indisponibilidade removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover indisponibilidade do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover indisponibilidade do professor', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MOTOR DE CONFLITOS — GET /schools/:schoolId/horarios/conflitos
// Varre TODOS os horários ativos da escola e devolve, agrupados por
// categoria, os conflitos reais encontrados. Nada é assumido: cada categoria
// só aparece se houver de facto um cruzamento de dados que a comprove.
// ═══════════════════════════════════════════════════════════════════════════════
export const getConflitosHorario = async (req, res) => {
  try {
    await ensureTabelasHorario();
    await ensureTabelaIndisponibilidade();
    const { schoolId } = req.params;

    // Hora real de cada (turno_id, ordem) — usado para mostrar "08:00–09:00"
    // em vez de só "aula nº 2", nos conflitos. Uma escola pode ter vários
    // turnos, cada um com sua própria configuração de hora início/fim.
    const turnos = await queryAsync(`SELECT id, nome, hora_inicio, hora_fim FROM turnos WHERE school_id = ?`, [schoolId]);
    const config = await getOrCreateHorarioConfig(schoolId);
    const slotsPorTurno = {};
    turnos.forEach((tn) => { slotsPorTurno[tn.id] = calcularSlotsDoDia(tn.hora_inicio, tn.hora_fim, config); });
    const horaDoSlot = (turnoId, ordem) => {
      const slots = slotsPorTurno[turnoId];
      const slot = slots ? slots[ordem - 1] : null;
      return slot ? `${String(slot.hora_inicio).slice(0, 5)}–${String(slot.hora_fim).slice(0, 5)}` : null;
    };
    const turnoNome = (turnoId) => turnos.find((t) => t.id === turnoId)?.nome || null;

    // ── 1. PROFESSOR DUPLICADO — o mesmo professor em 2+ turmas, mesmo
    // dia/turno/ordem (ou seja, exatamente à mesma hora real). ──────────────
    const linhasProfessor = await queryAsync(
      `
        SELECT h.teacher_id, te.nome as professor_nome, h.dia_semana, h.turno_id, h.ordem,
               h.turma_id, t.nome as turma_nome, d.nome as disciplina_nome
        FROM horarios h
        LEFT JOIN teachers te ON te.id = h.teacher_id
        LEFT JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN disciplinas d ON d.id = h.disciplina_id
        WHERE h.school_id = ? AND h.ativo = 1 AND h.teacher_id IS NOT NULL
        ORDER BY h.dia_semana, h.turno_id, h.ordem
      `,
      [schoolId]
    );
    const gruposProfessor = {};
    linhasProfessor.forEach((l) => {
      const chave = `${l.teacher_id}|${l.dia_semana}|${l.turno_id}|${l.ordem}`;
      (gruposProfessor[chave] = gruposProfessor[chave] || []).push(l);
    });
    const conflitosProfessor = Object.values(gruposProfessor)
      .filter((grupo) => new Set(grupo.map((g) => g.turma_id)).size > 1)
      .map((grupo) => ({
        tipo: 'professor_duplicado',
        professor_id: grupo[0].teacher_id,
        professor_nome: grupo[0].professor_nome,
        dia_semana: grupo[0].dia_semana,
        turno_nome: turnoNome(grupo[0].turno_id),
        horario: horaDoSlot(grupo[0].turno_id, grupo[0].ordem),
        turmas: grupo.map((g) => ({ turma_id: g.turma_id, turma_nome: g.turma_nome, disciplina_nome: g.disciplina_nome })),
      }));

    // ── 2. SALA OCUPADA — 2+ turmas na mesma sala, mesmo dia/turno/ordem. ───
    const linhasSala = await queryAsync(
      `
        SELECT h.sala_id, sl.numero as sala_numero, h.dia_semana, h.turno_id, h.ordem,
               h.turma_id, t.nome as turma_nome
        FROM horarios h
        LEFT JOIN salas sl ON sl.id = h.sala_id
        LEFT JOIN turmas t ON t.id = h.turma_id
        WHERE h.school_id = ? AND h.ativo = 1 AND h.sala_id IS NOT NULL
        ORDER BY h.dia_semana, h.turno_id, h.ordem
      `,
      [schoolId]
    );
    const gruposSala = {};
    linhasSala.forEach((l) => {
      const chave = `${l.sala_id}|${l.dia_semana}|${l.turno_id}|${l.ordem}`;
      (gruposSala[chave] = gruposSala[chave] || []).push(l);
    });
    const conflitosSala = Object.values(gruposSala)
      .filter((grupo) => new Set(grupo.map((g) => g.turma_id)).size > 1)
      .map((grupo) => ({
        tipo: 'sala_ocupada',
        sala_id: grupo[0].sala_id,
        sala_numero: grupo[0].sala_numero,
        dia_semana: grupo[0].dia_semana,
        turno_nome: turnoNome(grupo[0].turno_id),
        horario: horaDoSlot(grupo[0].turno_id, grupo[0].ordem),
        turmas: grupo.map((g) => ({ turma_id: g.turma_id, turma_nome: g.turma_nome })),
      }));

    // ── 3. TURMA DUPLICADA — a mesma turma com 2+ disciplinas no mesmo
    // dia/turno/ordem (não deveria acontecer nunca; sinaliza corrupção de
    // dados ou uma edição manual incorreta). ────────────────────────────────
    const linhasTurma = await queryAsync(
      `
        SELECT h.turma_id, t.nome as turma_nome, h.dia_semana, h.turno_id, h.ordem, d.nome as disciplina_nome
        FROM horarios h
        LEFT JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN disciplinas d ON d.id = h.disciplina_id
        WHERE h.school_id = ? AND h.ativo = 1
        ORDER BY h.dia_semana, h.turno_id, h.ordem
      `,
      [schoolId]
    );
    const gruposTurma = {};
    linhasTurma.forEach((l) => {
      const chave = `${l.turma_id}|${l.dia_semana}|${l.turno_id}|${l.ordem}`;
      (gruposTurma[chave] = gruposTurma[chave] || []).push(l);
    });
    const conflitosTurma = Object.values(gruposTurma)
      .filter((grupo) => grupo.length > 1)
      .map((grupo) => ({
        tipo: 'turma_duplicada',
        turma_id: grupo[0].turma_id,
        turma_nome: grupo[0].turma_nome,
        dia_semana: grupo[0].dia_semana,
        turno_nome: turnoNome(grupo[0].turno_id),
        horario: horaDoSlot(grupo[0].turno_id, grupo[0].ordem),
        disciplinas: grupo.map((g) => g.disciplina_nome),
      }));

    // ── 4. CARGA HORÁRIA EXCEDIDA — professor com mais aulas/semana do que a
    // carga horária prevista (teachers.carga_horaria_semanal). ─────────────
    let conflitosCarga = [];
    try {
      const linhas = await queryAsync(
        `
          SELECT te.id as teacher_id, te.nome as professor_nome, te.carga_horaria_semanal, COUNT(h.id) as carga_atual
          FROM teachers te
          LEFT JOIN horarios h ON h.teacher_id = te.id AND h.ativo = 1 AND h.school_id = te.school_id
          WHERE te.school_id = ? AND te.ativo = 1 AND te.carga_horaria_semanal IS NOT NULL
          GROUP BY te.id, te.nome, te.carga_horaria_semanal
          HAVING carga_atual > te.carga_horaria_semanal
        `,
        [schoolId]
      );
      conflitosCarga = linhas.map((l) => ({
        tipo: 'carga_horaria_excedida',
        professor_id: l.teacher_id,
        professor_nome: l.professor_nome,
        carga_prevista: l.carga_horaria_semanal,
        carga_atual: l.carga_atual,
      }));
    } catch (e) { /* teachers.carga_horaria_semanal pode ainda não existir nesta base */ }

    // ── 5. DISPONIBILIDADE DO PROFESSOR — aula atribuída num dia/turno em
    // que o professor foi explicitamente marcado como indisponível. ────────
    const indisponibilidades = await queryAsync(
      `SELECT teacher_id, dia_semana, turno_id, motivo FROM teacher_indisponibilidade WHERE school_id = ?`,
      [schoolId]
    );
    const conflitosDisponibilidade = [];
    if (indisponibilidades.length > 0) {
      const setIndisponivel = new Set(indisponibilidades.map((i) => `${i.teacher_id}|${i.dia_semana}|${i.turno_id}`));
      const linhas = await queryAsync(
        `
          SELECT h.teacher_id, te.nome as professor_nome, h.dia_semana, h.turno_id, h.ordem, h.turma_id, t.nome as turma_nome
          FROM horarios h
          LEFT JOIN teachers te ON te.id = h.teacher_id
          LEFT JOIN turmas t ON t.id = h.turma_id
          WHERE h.school_id = ? AND h.ativo = 1 AND h.teacher_id IS NOT NULL
        `,
        [schoolId]
      );
      linhas.forEach((l) => {
        const chave = `${l.teacher_id}|${l.dia_semana}|${l.turno_id}`;
        if (setIndisponivel.has(chave)) {
          const motivo = indisponibilidades.find((i) => `${i.teacher_id}|${i.dia_semana}|${i.turno_id}` === chave)?.motivo;
          conflitosDisponibilidade.push({
            tipo: 'disponibilidade_professor',
            professor_id: l.teacher_id,
            professor_nome: l.professor_nome,
            dia_semana: l.dia_semana,
            turno_nome: turnoNome(l.turno_id),
            horario: horaDoSlot(l.turno_id, l.ordem),
            turma_nome: l.turma_nome,
            motivo: motivo || null,
          });
        }
      });
    }

    // ── 6. INTERVALO / FORA DO HORÁRIO — aulas cuja `ordem` já não cabe na
    // janela atual do turno (normalmente porque a configuração de aula/
    // intervalo ou o turno foram alterados DEPOIS de o horário ter sido
    // gerado, deixando aulas "penduradas" fora do novo expediente). ────────
    const conflitosIntervalo = [];
    const linhasTodas = await queryAsync(
      `SELECT h.id, h.turma_id, t.nome as turma_nome, h.dia_semana, h.turno_id, h.ordem, d.nome as disciplina_nome
       FROM horarios h LEFT JOIN turmas t ON t.id = h.turma_id LEFT JOIN disciplinas d ON d.id = h.disciplina_id
       WHERE h.school_id = ? AND h.ativo = 1`,
      [schoolId]
    );
    linhasTodas.forEach((l) => {
      const slots = slotsPorTurno[l.turno_id];
      if (slots && l.ordem > slots.length) {
        conflitosIntervalo.push({
          tipo: 'fora_do_horario',
          turma_id: l.turma_id,
          turma_nome: l.turma_nome,
          dia_semana: l.dia_semana,
          turno_nome: turnoNome(l.turno_id),
          disciplina_nome: l.disciplina_nome,
          detalhe: `Esta aula (${l.ordem}ª do dia) já não cabe na janela atual do turno — verifique se o turno ou a configuração de aula/intervalo mudaram depois deste horário ter sido gerado.`,
        });
      }
    });

    const total = conflitosProfessor.length + conflitosSala.length + conflitosTurma.length + conflitosCarga.length + conflitosDisponibilidade.length + conflitosIntervalo.length;

    res.json({
      success: true,
      total,
      conflitos: {
        professor_duplicado: conflitosProfessor,
        sala_ocupada: conflitosSala,
        turma_duplicada: conflitosTurma,
        carga_horaria_excedida: conflitosCarga,
        disponibilidade_professor: conflitosDisponibilidade,
        fora_do_horario: conflitosIntervalo,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao detectar conflitos de horário:', err);
    res.status(500).json({ success: false, message: 'Erro ao detectar conflitos de horário', error: err.message });
  }
};

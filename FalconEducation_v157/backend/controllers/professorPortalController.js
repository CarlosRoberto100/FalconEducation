import db from '../config/db.js';
import bcrypt from 'bcrypt';
import { getOrCreateHorarioConfig, calcularSlotsDoDia } from './horarioController.js';
import { resolverAnoLetivoPorData } from './academicYearController.js';
import { ensureClassDisciplinaSecaoColumnExists } from './secaoController.js';
import {
  ESCALA_MIN, ESCALA_MAX, listarTiposPermitidos, getConfigAvaliacao,
  ensureGradeColumnsExist, ensureClassDisciplinasTableExists,
  calcularMediaDisciplina, avaliacaoContinuaCompleta, calcularSituacaoDisciplina,
  classificarQualitativamente,
} from './gradeController.js';
import { ensurePresencasTableExists, getResumoFaltasTurma } from './attendanceController.js';
import { getFaltasProfessor } from './teacherAdminController.js';
import { criarNotificacao } from './notificationController.js';
import { classeTemExameEfetivo } from '../services/configuracaoAcademicaService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const DIAS_SEMANA_PADRAO = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
const STATUS_PRESENCA_VALIDOS = ['presente', 'falta', 'atraso', 'justificada'];

/**
 * v80 — confirma que o professor autenticado DÁ MESMO a disciplina indicada
 * nesta turma, segundo o horário (fonte única de verdade de quem ensina o
 * quê, onde). Usada antes de aceitar lançamento de notas ou presença, para
 * um professor nunca conseguir escrever dados de uma turma/disciplina que
 * não é sua — mesmo que descubra o ID de outra turma.
 */
export const confirmarProfessorLecionaTurma = async (schoolId, teacherId, turmaId, disciplinaId = null) => {
  const condicaoDisciplina = disciplinaId ? 'AND disciplina_id = ?' : '';
  const params = disciplinaId ? [schoolId, teacherId, turmaId, disciplinaId] : [schoolId, teacherId, turmaId];
  const rows = await queryAsync(
    `SELECT id FROM horarios WHERE school_id = ? AND teacher_id = ? AND turma_id = ? ${condicaoDisciplina} AND ativo = 1 LIMIT 1`,
    params
  );
  return rows.length > 0;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ÁREA DO PROFESSOR — v80
// ─────────────────────────────────────────────────────────────────────────────
// Todos os endpoints aqui são "sobre mim": nunca recebem um :teacherId na
// URL, identificam sempre o professor a partir de req.user.id (preenchido
// pelo verifyToken a partir do JWT emitido em authTeacherController.js).
// Isto impede, por construção, que um professor consiga ver dados de outro
// só por adivinhar/alterar um ID na URL.
//
// Deliberadamente NÃO inclui dados de RH sensíveis (salário, contrato,
// faltas/advertências administrativas — ver teacherAdminController.js, que
// é só para o admin ver). Este portal mostra apenas o que o próprio
// professor precisa no dia a dia: o seu perfil, as suas turmas/disciplinas
// e o seu horário semanal.
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/professor/me/perfil
export const getMeuPerfil = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    const rows = await queryAsync(
      `SELECT id, nome, email, telefone, genero, codigo_professor, morada, data_admissao, ativo
       FROM teachers WHERE id = ? AND school_id = ? LIMIT 1`,
      [teacherId, schoolId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Professor não encontrado' });
    const professor = rows[0];

    const disciplinas = await queryAsync(
      `SELECT d.id, d.nome FROM teacher_disciplines td JOIN disciplinas d ON d.id = td.disciplina_id WHERE td.teacher_id = ? ORDER BY d.nome ASC`,
      [teacherId]
    );

    // Turmas onde este professor dá pelo menos uma aula, segundo o horário
    // (fonte única de verdade — é o `horarios` que diz quem ensina o quê,
    // onde e quando, não uma atribuição solta).
    const turmas = await queryAsync(
      `
        SELECT DISTINCT t.id, t.nome, c.nome as classe_nome, tn.nome as turno_nome
        FROM horarios h
        JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN turnos tn ON tn.id = t.turno_id
        WHERE h.school_id = ? AND h.teacher_id = ? AND h.ativo = 1
        ORDER BY c.nome ASC, t.nome ASC
      `,
      [schoolId, teacherId]
    );

    const [resumo] = await queryAsync(
      `SELECT COUNT(*) as total_aulas_semana FROM horarios WHERE school_id = ? AND teacher_id = ? AND ativo = 1`,
      [schoolId, teacherId]
    );

    res.json({
      success: true,
      data: {
        ...professor,
        disciplinas,
        turmas,
        total_turmas: turmas.length,
        total_disciplinas: disciplinas.length,
        total_aulas_semana: resumo?.total_aulas_semana || 0,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar perfil do professor (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar perfil', error: err.message });
  }
};

// GET /api/professor/me/horario
// Horário semanal agregando TODAS as turmas do professor num único mapa
// dia → lista de aulas (cada aula já traz a que turma/disciplina pertence),
// ao contrário de getHorarioTurma (horarioController.js) que é por turma.
export const getMeuHorario = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    const aulas = await queryAsync(
      `
        SELECT h.dia_semana, h.ordem, h.disciplina_id, d.nome as disciplina_nome,
               h.turma_id, t.nome as turma_nome, c.nome as classe_nome,
               tn.hora_inicio as turno_hora_inicio, tn.hora_fim as turno_hora_fim, tn.dias_semana as turno_dias
        FROM horarios h
        JOIN disciplinas d ON d.id = h.disciplina_id
        JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN turnos tn ON tn.id = t.turno_id
        WHERE h.school_id = ? AND h.teacher_id = ? AND h.ativo = 1
        ORDER BY h.dia_semana ASC, h.ordem ASC
      `,
      [schoolId, teacherId]
    );

    const config = await getOrCreateHorarioConfig(schoolId);
    // Cache de slots por turno (hora_inicio+hora_fim) — várias turmas podem
    // partilhar o mesmo turno, não vale a pena recalcular os mesmos slots.
    const slotsPorTurno = new Map();
    const aulasComHorario = aulas.map((aula) => {
      const chaveTurno = `${aula.turno_hora_inicio}-${aula.turno_hora_fim}`;
      if (!slotsPorTurno.has(chaveTurno) && aula.turno_hora_inicio) {
        slotsPorTurno.set(chaveTurno, calcularSlotsDoDia(aula.turno_hora_inicio, aula.turno_hora_fim, config));
      }
      const slots = slotsPorTurno.get(chaveTurno) || [];
      const slot = slots[aula.ordem - 1];
      return {
        dia_semana: aula.dia_semana,
        ordem: aula.ordem,
        disciplina: aula.disciplina_nome,
        turma: aula.turma_nome,
        classe: aula.classe_nome,
        hora_inicio: slot?.hora_inicio || null,
        hora_fim: slot?.hora_fim || null,
      };
    });

    // Agrupado por dia, já ordenado por hora — pronto para a interface
    // desenhar uma grelha semanal sem precisar de reprocessar nada.
    const porDia = {};
    DIAS_SEMANA_PADRAO.forEach((dia) => { porDia[dia] = []; });
    aulasComHorario.forEach((aula) => {
      if (!porDia[aula.dia_semana]) porDia[aula.dia_semana] = [];
      porDia[aula.dia_semana].push(aula);
    });
    Object.keys(porDia).forEach((dia) => {
      porDia[dia].sort((a, b) => (a.hora_inicio || '').localeCompare(b.hora_inicio || ''));
    });

    res.json({ success: true, dias: DIAS_SEMANA_PADRAO, horario: porDia, total_aulas: aulasComHorario.length });
  } catch (err) {
    console.error('[v0] Erro ao buscar horário do professor (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar horário', error: err.message });
  }
};

// GET /api/professor/me/turmas/:turmaId/alunos
// Lista os alunos ativos da turma — só se o professor der mesmo aula nela
// (qualquer disciplina). Usada para montar as telas de presença e notas.
export const getMeusAlunosDaTurma = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;

    const lecionaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId);
    if (!lecionaTurma) {
      return res.status(403).json({ success: false, message: 'Não é professor desta turma.' });
    }

    const alunos = await queryAsync(
      `SELECT id, nome, codigo_aluno FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1 ORDER BY nome ASC`,
      [schoolId, turmaId]
    );
    const disciplinas = await queryAsync(
      `
        SELECT DISTINCT d.id, d.nome
        FROM horarios h JOIN disciplinas d ON d.id = h.disciplina_id
        WHERE h.school_id = ? AND h.teacher_id = ? AND h.turma_id = ? AND h.ativo = 1
        ORDER BY d.nome ASC
      `,
      [schoolId, teacherId, turmaId]
    );
    const configAvaliacao = await getConfigAvaliacao(schoolId);

    const notas = alunos.length > 0 && disciplinas.length > 0
      ? await queryAsync(
        `SELECT student_id, disciplina_id, valor, tipo_avaliacao
         FROM grades WHERE school_id = ? AND turma_id = ?
         AND disciplina_id IN (${disciplinas.map(() => '?').join(',')})`,
        [schoolId, turmaId, ...disciplinas.map((disciplina) => disciplina.id)]
      )
      : [];
    const elegibilidadeExame = {};
    alunos.forEach((aluno) => {
      elegibilidadeExame[aluno.id] = {};
      disciplinas.forEach((disciplina) => {
        const notasDisciplina = notas.filter((nota) => nota.student_id === aluno.id && nota.disciplina_id === disciplina.id);
        const testes = notasDisciplina.filter((nota) => /^Teste/i.test(String(nota.tipo_avaliacao || ''))).map((nota) => ({ valor: parseFloat(nota.valor) }));
        const trabalhos = notasDisciplina.filter((nota) => /^Trabalho/i.test(String(nota.tipo_avaliacao || ''))).map((nota) => ({ valor: parseFloat(nota.valor) }));
        const acp = notasDisciplina.find((nota) => /^ACP/i.test(String(nota.tipo_avaliacao || '')));
        const exame1 = notasDisciplina.find((nota) => nota.tipo_avaliacao === 'Exame');
        const exame2 = notasDisciplina.find((nota) => nota.tipo_avaliacao === 'Exame (2ª Época)');
        const notaCurso = calcularMediaDisciplina({ testes, trabalhos, acp: acp ? { valor: parseFloat(acp.valor) } : null, exame: null }, configAvaliacao);
        const completo = avaliacaoContinuaCompleta({ testes, trabalhos, acp }, configAvaliacao);
        const situacao = calcularSituacaoDisciplina(notaCurso, false, configAvaliacao, completo).situacao;
        elegibilidadeExame[aluno.id][disciplina.id] = {
          elegivel: situacao === 'Vai a Exame', nota_curso: notaCurso, situacao,
          exame_1a: exame1 ? parseFloat(exame1.valor) : null,
          exame_2a: exame2 ? parseFloat(exame2.valor) : null,
        };
      });
    });
    const alunosComElegibilidade = alunos.map((aluno) => ({ ...aluno, elegiveis_exame: elegibilidadeExame[aluno.id] || {} }));

    // v80 — devolvido aqui para o formulário de lançamento de notas do
    // frontend já saber que tipos de avaliação são válidos para esta escola
    // (ex.: "Teste 1", "Trabalho 2", "ACP", "Exame"), sem precisar de outro
    // pedido — a mesma regra de negócio de listarTiposPermitidos que já
    // protege o lado do admin.
    // v147 — "Exame" agora também depende de a CLASSE desta turma ter exame
    // (configuracaoAcademicaService.js), não só do interruptor geral da escola.
    const turmaRows = await queryAsync(
      `SELECT t.class_id, c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ?`,
      [turmaId, schoolId]
    );
    const temExameNestaClasse = await classeTemExameEfetivo(schoolId, turmaRows[0]?.class_id || null, turmaRows[0]?.classe_nome || null, configAvaliacao);
    const existeAlunoElegivelParaExame = Object.values(elegibilidadeExame).some((porDisciplina) => Object.values(porDisciplina).some((item) => item.elegivel));
    const tiposAvaliacaoPermitidos = listarTiposPermitidos(configAvaliacao, temExameNestaClasse || existeAlunoElegivelParaExame);

    res.json({ success: true, data: { alunos: alunosComElegibilidade, disciplinas, tipos_avaliacao_permitidos: tiposAvaliacaoPermitidos } });
  } catch (err) {
    console.error('[v0] Erro ao buscar alunos da turma (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar alunos', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRESENÇA — v80
// ─────────────────────────────────────────────────────────────────────────────
// Reaproveita a MESMA tabela `presencas` e a mesma lógica de negócio do lado
// do admin (attendanceController.js já lê `registrado_por` de req.user.id,
// foi desenhado desde o início para servir qualquer utilizador autenticado
// — não precisou de alterações). Aqui só acrescentamos a verificação de que
// o professor dá mesmo aula a esta turma antes de deixar ver/gravar.
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/professor/me/turmas/:turmaId/presencas?data=YYYY-MM-DD
export const getMinhaPresencaTurma = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;
    const data = req.query.data || new Date().toISOString().split('T')[0];

    const lecionaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId);
    if (!lecionaTurma) {
      return res.status(403).json({ success: false, message: 'Não é professor desta turma.' });
    }

    const alunos = await queryAsync(
      `
        SELECT s.id AS student_id, s.nome, s.codigo_aluno, p.status, p.observacao
        FROM students s
        LEFT JOIN presencas p ON p.student_id = s.id AND p.data = ?
        WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1
        ORDER BY s.nome ASC
      `,
      [data, schoolId, turmaId]
    );

    res.json({ success: true, data: alunos, meta: { data, turmaId: Number(turmaId) } });
  } catch (err) {
    console.error('[v0] Erro ao buscar presença (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar presença', error: err.message });
  }
};

// POST /api/professor/me/turmas/:turmaId/presencas
// Body: { data: 'YYYY-MM-DD', registros: [{ student_id, status, observacao }] }
export const marcarMinhaPresencaTurma = async (req, res) => {
  try {
    await ensurePresencasTableExists();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;
    const { data, registros } = req.body;

    const lecionaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId);
    if (!lecionaTurma) {
      return res.status(403).json({ success: false, message: 'Não é professor desta turma.' });
    }
    if (!data) return res.status(400).json({ success: false, message: 'Informe a data da chamada' });
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum registo de presença foi enviado' });
    }
    for (const r of registros) {
      if (!r.student_id || !STATUS_PRESENCA_VALIDOS.includes(r.status)) {
        return res.status(400).json({ success: false, message: `Registo inválido para o aluno ${r.student_id}` });
      }
    }
    // Confirma que todos os alunos pertencem mesmo a esta turma desta escola
    // — impede um pedido manipulado a tentar marcar presença de um aluno de
    // outra turma/escola através deste endpoint.
    const idsAlunos = registros.map((r) => r.student_id);
    const alunosValidos = await queryAsync(
      `SELECT id FROM students WHERE school_id = ? AND turma_id = ? AND id IN (${idsAlunos.map(() => '?').join(',')})`,
      [schoolId, turmaId, ...idsAlunos]
    );
    if (alunosValidos.length !== idsAlunos.length) {
      return res.status(400).json({ success: false, message: 'Um ou mais alunos não pertencem a esta turma.' });
    }

    const anoLetivo = await resolverAnoLetivoPorData(schoolId, data);
    for (const r of registros) {
      await queryAsync(
        `
          INSERT INTO presencas (school_id, student_id, turma_id, data, academic_year_id, status, observacao, registrado_por)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            status = VALUES(status), observacao = VALUES(observacao), turma_id = VALUES(turma_id),
            academic_year_id = VALUES(academic_year_id), registrado_por = VALUES(registrado_por), updated_at = NOW()
        `,
        [schoolId, r.student_id, turmaId, data, anoLetivo.virtual ? null : anoLetivo.id, r.status, r.observacao || null, teacherId]
      );
    }

    // Mesmo alerta de "múltiplo de 5 faltas" que já existe do lado do admin
    // (attendanceController.js#saveAttendanceBulk) — mantém o admin a par
    // mesmo quando é o professor a marcar a chamada, não só ele próprio.
    try {
      const alunosComFalta = [...new Set(registros.filter((r) => r.status === 'falta').map((r) => r.student_id))];
      for (const alunoId of alunosComFalta) {
        const [linha] = await queryAsync(`SELECT COUNT(*) as total FROM presencas WHERE school_id = ? AND student_id = ? AND status = 'falta'`, [schoolId, alunoId]);
        const totalFaltas = linha?.total || 0;
        if (totalFaltas > 0 && totalFaltas % 5 === 0) {
          const [aluno] = await queryAsync(`SELECT nome FROM students WHERE id = ? AND school_id = ?`, [alunoId, schoolId]);
          await criarNotificacao(schoolId, 'faltas', 'Aluno com muitas faltas', `${aluno?.nome || 'Aluno'} já acumula ${totalFaltas} falta(s).`);
        }
      }
    } catch (erroNotif) {
      console.error('[v0] Aviso: não foi possível verificar notificações de faltas (portal do professor):', erroNotif.message);
    }

    res.json({ success: true, message: `Presença registada para ${registros.length} aluno(s) em ${data}.` });
  } catch (err) {
    console.error('[v0] Erro ao registar presença (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao registar presença', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// NOTAS — v80
// ─────────────────────────────────────────────────────────────────────────────
// Ao contrário do endpoint do admin (gradeController.js#createGrade, que
// lança UMA nota de UM aluno por pedido), aqui lançamos a turma inteira de
// uma vez — é assim que um professor trabalha na prática (uma folha de
// notas por disciplina/avaliação, não aluno a aluno). Reaproveita as MESMAS
// regras de negócio do admin (escala 0–20, tipos de avaliação permitidos
// pela configuração da escola, verificação de nota bloqueada, currículo da
// classe) importadas de gradeController.js — não duplicadas.
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/professor/me/turmas/:turmaId/notas
// Body: { disciplina_id, tipo_avaliacao, periodo, data_avaliacao, notas: [{ student_id, valor }] }
export const lancarMinhasNotasTurma = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    await ensureClassDisciplinasTableExists();
    await ensureClassDisciplinaSecaoColumnExists();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;
    const { disciplina_id, tipo_avaliacao, periodo, data_avaliacao, notas } = req.body;

    if (!disciplina_id) return res.status(400).json({ success: false, message: 'Selecione a disciplina' });
    if (!periodo) return res.status(400).json({ success: false, message: 'Selecione o período letivo' });
    if (!Array.isArray(notas) || notas.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma nota foi enviada' });
    }

    const lecionaDisciplinaNaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId, disciplina_id);
    if (!lecionaDisciplinaNaTurma) {
      return res.status(403).json({ success: false, message: 'Não dá esta disciplina nesta turma, segundo o horário.' });
    }

    // Currículo: se a classe já tem disciplinas configuradas (aba
    // Disciplinas), a disciplina lançada precisa de pertencer a esse
    // currículo — mesma regra que já protege o lado do admin. v94: também
    // considera a secção da turma (comuns + específicas da secção).
    // v147: esta consulta subiu para antes da validação do tipo de
    // avaliação, porque agora também precisamos da classe para saber se
    // "Exame" é válido nesta turma.
    const turmaRows = await queryAsync(`SELECT class_id, secao_id FROM turmas WHERE id = ? AND school_id = ?`, [turmaId, schoolId]);
    const classeId = turmaRows[0]?.class_id || null;
    const secaoIdTurma = turmaRows[0]?.secao_id || 0;
    let classeNome = null;
    if (classeId) {
      const classeRows = await queryAsync(`SELECT nome FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
      classeNome = classeRows[0]?.nome || null;
    }

    const config = await getConfigAvaliacao(schoolId);
    const temExameNestaClasse = await classeTemExameEfetivo(schoolId, classeId, classeNome, config);
    const tiposPermitidos = listarTiposPermitidos(config, temExameNestaClasse);
    const ehTipoExame = tipo_avaliacao === 'Exame' || tipo_avaliacao === 'Exame (2ª Época)';
    if (!tiposPermitidos.includes(tipo_avaliacao) && !(ehTipoExame && config.usa_exame)) {
      return res.status(400).json({ success: false, message: `Tipo de avaliação inválido. Tipos permitidos: ${tiposPermitidos.join(', ')}` });
    }

    if (classeId) {
      const totalVinculos = await queryAsync(`SELECT COUNT(*) as total FROM class_disciplinas WHERE classe_id = ?`, [classeId]);
      if ((totalVinculos[0]?.total || 0) > 0) {
        const pertence = await queryAsync(`SELECT id FROM class_disciplinas WHERE classe_id = ? AND disciplina_id = ? AND secao_id IN (0, ?)`, [classeId, disciplina_id, secaoIdTurma]);
        if (pertence.length === 0) {
          return res.status(400).json({ success: false, message: 'Esta disciplina não está associada ao currículo desta classe/secção.' });
        }
      }
    }

    const idsAlunos = notas.map((n) => n.student_id);
    const alunosValidos = await queryAsync(
      `SELECT id FROM students WHERE school_id = ? AND turma_id = ? AND id IN (${idsAlunos.map(() => '?').join(',')})`,
      [schoolId, turmaId, ...idsAlunos]
    );
    const idsValidosSet = new Set(alunosValidos.map((a) => a.id));

    if (tipo_avaliacao === 'Exame' || tipo_avaliacao === 'Exame (2ª Época)') {
      const candidatos = await queryAsync(
        `SELECT g.student_id, g.valor, g.tipo_avaliacao
         FROM grades g WHERE g.school_id = ? AND g.turma_id = ? AND g.disciplina_id = ?`,
        [schoolId, turmaId, disciplina_id]
      );
      const elegiveis = new Set();
      for (const alunoId of idsValidosSet) {
        const notasAluno = candidatos.filter((nota) => nota.student_id === alunoId);
        const testes = notasAluno.filter((nota) => /^Teste/i.test(String(nota.tipo_avaliacao || ''))).map((nota) => ({ valor: parseFloat(nota.valor) }));
        const trabalhos = notasAluno.filter((nota) => /^Trabalho/i.test(String(nota.tipo_avaliacao || ''))).map((nota) => ({ valor: parseFloat(nota.valor) }));
        const acp = notasAluno.find((nota) => /^ACP/i.test(String(nota.tipo_avaliacao || '')));
        const notaCurso = calcularMediaDisciplina({ testes, trabalhos, acp: acp ? { valor: parseFloat(acp.valor) } : null, exame: null }, config);
        const completo = avaliacaoContinuaCompleta({ testes, trabalhos, acp }, config);
        if (calcularSituacaoDisciplina(notaCurso, false, config, completo).situacao === 'Vai a Exame') elegiveis.add(alunoId);
      }
      const naoElegiveis = notas.filter((nota) => !elegiveis.has(nota.student_id));
      if (naoElegiveis.length > 0) {
        return res.status(400).json({ success: false, message: 'Só é permitido lançar exame para alunos cuja classificação nesta disciplina seja “Vai a Exame”.', alunos_nao_elegiveis: naoElegiveis.map((nota) => nota.student_id) });
      }
    }

    const dataAvaliacaoFinal = data_avaliacao || new Date().toISOString().split('T')[0];
    const anoLetivoResolvido = await resolverAnoLetivoPorData(schoolId, dataAvaliacaoFinal);
    const anoLetivo = /^\d+$/.test(anoLetivoResolvido.nome) ? parseInt(anoLetivoResolvido.nome, 10) : new Date(anoLetivoResolvido.data_inicio).getFullYear();
    const academicYearId = anoLetivoResolvido.virtual ? null : anoLetivoResolvido.id;

    const lancadas = [];
    const bloqueadas = [];
    const invalidas = [];

    for (const n of notas) {
      if (!idsValidosSet.has(n.student_id)) { invalidas.push({ student_id: n.student_id, motivo: 'Aluno não pertence a esta turma' }); continue; }
      const valorNumerico = parseFloat(n.valor);
      if (n.valor === undefined || n.valor === null || n.valor === '' || isNaN(valorNumerico)) { invalidas.push({ student_id: n.student_id, motivo: 'Nota vazia ou inválida' }); continue; }
      if (valorNumerico < ESCALA_MIN || valorNumerico > ESCALA_MAX) { invalidas.push({ student_id: n.student_id, motivo: `Nota deve estar entre ${ESCALA_MIN} e ${ESCALA_MAX}` }); continue; }

      const existente = await queryAsync(
        `SELECT id, bloqueada FROM grades WHERE school_id = ? AND student_id = ? AND disciplina_id = ? AND tipo_avaliacao = ? AND periodo = ? AND ano_letivo = ? LIMIT 1`,
        [schoolId, n.student_id, disciplina_id, tipo_avaliacao, periodo, anoLetivo]
      );

      if (existente.length > 0) {
        if (existente[0].bloqueada) { bloqueadas.push(n.student_id); continue; }
        await queryAsync(
          `UPDATE grades SET valor = ?, teacher_id = ?, data_avaliacao = ?, classe_id = ?, academic_year_id = ?, updated_at = NOW() WHERE id = ?`,
          [valorNumerico, teacherId, dataAvaliacaoFinal, classeId, academicYearId, existente[0].id]
        );
      } else {
        await queryAsync(
          `
            INSERT INTO grades (school_id, student_id, disciplina_id, teacher_id, turma_id, classe_id, valor, tipo_avaliacao, data_avaliacao, periodo, ano_letivo, academic_year_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [schoolId, n.student_id, disciplina_id, teacherId, turmaId, classeId, valorNumerico, tipo_avaliacao, dataAvaliacaoFinal, periodo, anoLetivo, academicYearId]
        );
      }
      lancadas.push(n.student_id);
    }

    res.json({
      success: true,
      message: `${lancadas.length} nota(s) lançada(s).${bloqueadas.length ? ` ${bloqueadas.length} já estava(m) bloqueada(s) e não foi(ram) alterada(s).` : ''}${invalidas.length ? ` ${invalidas.length} inválida(s), ignorada(s).` : ''}`,
      lancadas: lancadas.length,
      bloqueadas,
      invalidas,
    });
  } catch (err) {
    console.error('[v0] Erro ao lançar notas em massa (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao lançar notas', error: err.message });
  }
};

// PUT /api/professor/me/senha
// Body: { senhaAtual, novaSenha }
// v80 — "esqueci a senha" self-service (recuperação por email/SMS) exigiria
// infraestrutura de envio que o sistema ainda não tem — não implementado por
// falta de base, não por descuido (ver CHANGELOG). Isto aqui é o que É
// seguro fazer sem essa infraestrutura: o professor, já autenticado, troca a
// própria senha sabendo a atual. Se esquecer mesmo a senha, continua a
// precisar do admin (editar o professor) — como já acontecia antes da v80.
export const alterarMinhaSenha = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { senhaAtual, novaSenha } = req.body;

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ success: false, message: 'Informe a senha atual e a nova senha' });
    }
    if (String(novaSenha).length < 6) {
      return res.status(400).json({ success: false, message: 'A nova senha deve ter no mínimo 6 caracteres' });
    }

    const rows = await queryAsync(`SELECT password FROM teachers WHERE id = ? AND school_id = ? LIMIT 1`, [teacherId, schoolId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Professor não encontrado' });

    const senhaValida = await bcrypt.compare(senhaAtual, rows[0].password);
    if (!senhaValida) {
      return res.status(401).json({ success: false, message: 'A senha atual está incorreta' });
    }

    const novaHash = await bcrypt.hash(novaSenha, 10);
    await queryAsync(`UPDATE teachers SET password = ?, updated_at = NOW() WHERE id = ?`, [novaHash, teacherId]);

    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao alterar senha (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao alterar senha', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// AMPLIAÇÃO — v84
// ─────────────────────────────────────────────────────────────────────────────
// Quatro acréscimos, cada um pedindo um nível de cuidado diferente:
//   1) Resumo de faltas da turma — presença é lançada ao nível da turma (não
//      por disciplina), por isso qualquer professor que dê aulas na turma já
//      vê o quadro completo de faltas dela; reaproveita getResumoFaltasTurma
//      tal como está, sem filtrar nada.
//   2) Pauta da turma — ao contrário das faltas, notas SÃO por disciplina, e
//      getBoletimTurma (admin) devolve TODAS as disciplinas da turma. Reaproveitar
//      isso tal como está exporia a um professor as notas de disciplinas que
//      não são suas — por isso aqui é uma função própria, mais restrita, que
//      só devolve a(s) disciplina(s) que o professor autenticado realmente dá
//      nesta turma.
//   3) Minhas faltas (professor) — as próprias faltas do professor como
//      funcionário (registadas pelo admin), reaproveitando getFaltasProfessor
//      forçando sempre teacherId = req.user.id.
//   4) Atividade recente — últimas notas/presenças lançadas por mim, para o
//      professor confirmar rapidamente o que já fez sem abrir cada turma.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Envolve um handler feito para o admin que lê teacherId de req.params
 * (ex.: getFaltasProfessor) e força esse parâmetro a vir sempre do token do
 * professor autenticado — nunca de um valor que o cliente possa enviar.
 */
export const comHandlerDeAdminAdaptadoProfessor = (handler) => (req, res) => {
  req.params.schoolId = String(req.user.school_id);
  req.params.teacherId = String(req.user.id);
  return handler(req, res);
};

// GET /api/professor/me/turmas/:turmaId/resumo-faltas
export const getResumoFaltasMinhaTurma = async (req, res) => {
  const { turmaId } = req.params;
  const lecionaTurma = await confirmarProfessorLecionaTurma(req.user.school_id, req.user.id, turmaId);
  if (!lecionaTurma) return res.status(403).json({ success: false, message: 'Não é professor desta turma.' });
  req.params.schoolId = String(req.user.school_id);
  return getResumoFaltasTurma(req, res);
};

// GET /api/professor/me/turmas/:turmaId/pauta
// Mapa de notas da turma, restrito às disciplinas que o professor
// autenticado realmente dá nesta turma (nunca as disciplinas de outros
// professores, mesmo que sejam colegas na mesma turma).
export const getMinhaPautaTurma = async (req, res) => {
  try {
    await ensureGradeColumnsExist();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;

    const lecionaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId);
    if (!lecionaTurma) return res.status(403).json({ success: false, message: 'Não é professor desta turma.' });

    const turmaRows = await queryAsync(`SELECT t.id, t.nome, c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ? LIMIT 1`, [turmaId, schoolId]);
    if (turmaRows.length === 0) return res.status(404).json({ success: false, message: 'Turma não encontrada' });

    // Só as disciplinas que ESTE professor dá nesta turma — a fronteira de
    // segurança que diferencia isto de getBoletimTurma (admin).
    const disciplinas = await queryAsync(
      `SELECT DISTINCT d.id, d.nome FROM horarios h JOIN disciplinas d ON d.id = h.disciplina_id WHERE h.school_id = ? AND h.teacher_id = ? AND h.turma_id = ? AND h.ativo = 1 ORDER BY d.nome ASC`,
      [schoolId, teacherId, turmaId]
    );
    if (disciplinas.length === 0) {
      return res.json({ success: true, turma: turmaRows[0], disciplinas: [], alunos: [] });
    }

    const config = await getConfigAvaliacao(schoolId);
    const idsDisciplinas = disciplinas.map((d) => d.id);

    const alunos = await queryAsync(`SELECT id, nome, codigo_aluno FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1 ORDER BY nome ASC`, [schoolId, turmaId]);
    const notas = alunos.length > 0
      ? await queryAsync(
          `SELECT student_id, disciplina_id, valor, tipo_avaliacao FROM grades WHERE school_id = ? AND turma_id = ? AND disciplina_id IN (${idsDisciplinas.map(() => '?').join(',')})`,
          [schoolId, turmaId, ...idsDisciplinas]
        )
      : [];

    const linhas = alunos.map((aluno) => {
      const notasAluno = notas.filter((n) => n.student_id === aluno.id);
      const notasPorDisciplina = {};
      disciplinas.forEach((disc) => {
        const doDisc = notasAluno.filter((n) => n.disciplina_id === disc.id);
        const testes = doDisc.filter((n) => /^Teste/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
        const trabalhos = doDisc.filter((n) => /^Trabalho/i.test(String(n.tipo_avaliacao || ''))).map((n) => ({ valor: parseFloat(n.valor) }));
        const acpRow = doDisc.find((n) => /^ACP/i.test(String(n.tipo_avaliacao || '')));
        const exameRow = doDisc.find((n) => /^Exame/i.test(String(n.tipo_avaliacao || '')));
        const acp = acpRow ? { valor: parseFloat(acpRow.valor) } : null;
        const exame = exameRow ? { valor: parseFloat(exameRow.valor) } : null;
        const media = calcularMediaDisciplina({ testes, trabalhos, acp, exame }, config);
        const completo = avaliacaoContinuaCompleta({ testes, trabalhos, acp }, config);
        const { situacao } = calcularSituacaoDisciplina(media, !!exameRow, config, completo);
        // v133 — inclui o detalhe (testes/trabalhos/ACP/exame), não só a média,
        // para a pauta do professor poder mostrar todas as notas lançadas ao expandir.
        notasPorDisciplina[disc.id] = { media, situacao, completo, testes, trabalhos, acp, exame, classificacao: classificarQualitativamente(media) };
      });
      return { student_id: aluno.id, nome: aluno.nome, codigo_aluno: aluno.codigo_aluno, notas: notasPorDisciplina };
    });

    res.json({ success: true, turma: turmaRows[0], disciplinas, alunos: linhas });
  } catch (err) {
    console.error('[v0] Erro ao montar pauta da turma (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao montar pauta', error: err.message });
  }
};

// GET /api/professor/me/atividade-recente
// Últimas notas e presenças lançadas por ESTE professor — um "acabei de
// fazer isto" rápido, sem ter de abrir cada turma para confirmar.
export const getMinhaAtividadeRecente = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    // v113 — antes, uma falha aqui virava lista vazia, indistinguível de
    // "sem lançamentos recentes". Agora cada bloco marca `_falhou` para o
    // frontend poder avisar em vez de mostrar "nenhuma atividade" por engano.
    let notasRecentes = [];
    let notasFalhou = false;
    try {
      notasRecentes = await queryAsync(
        `
          SELECT g.id, g.valor, g.tipo_avaliacao, g.periodo, g.updated_at,
                 s.nome as aluno_nome, d.nome as disciplina_nome, t.nome as turma_nome
          FROM grades g
          JOIN students s ON s.id = g.student_id
          JOIN disciplinas d ON d.id = g.disciplina_id
          LEFT JOIN turmas t ON t.id = g.turma_id
          WHERE g.school_id = ? AND g.teacher_id = ?
          ORDER BY g.updated_at DESC LIMIT 15
        `,
        [schoolId, teacherId]
      );
    } catch (e) {
      console.error('[v0] Falha ao consultar notas recentes do professor:', e.message);
      notasFalhou = true;
    }

    let presencasRecentes = [];
    let presencasFalhou = false;
    try {
      presencasRecentes = await queryAsync(
        `
          SELECT p.data, p.turma_id, t.nome as turma_nome, COUNT(*) as total_alunos,
                 SUM(CASE WHEN p.status = 'falta' THEN 1 ELSE 0 END) as total_faltas
          FROM presencas p
          LEFT JOIN turmas t ON t.id = p.turma_id
          WHERE p.school_id = ? AND p.registrado_por = ?
          GROUP BY p.data, p.turma_id, t.nome
          ORDER BY p.data DESC LIMIT 10
        `,
        [schoolId, teacherId]
      );
    } catch (e) {
      console.error('[v0] Falha ao consultar presenças recentes do professor:', e.message);
      presencasFalhou = true;
    }

    res.json({
      success: true,
      notas: notasRecentes, notas_indisponivel: notasFalhou,
      presencas: presencasRecentes, presencas_indisponivel: presencasFalhou,
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar atividade recente (portal do professor):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar atividade recente', error: err.message });
  }
};

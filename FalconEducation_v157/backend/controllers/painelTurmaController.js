import db from '../config/db.js';
import { getSituacoesAcademicasEscola } from '../services/academicStatusService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAINEL DA TURMA — "8ª Classe A: Alunos 32/35 · Professor titular: Carlos ·
// Sala: B12 · Turno: Manhã · Média: 13.8 · Presença: 91% · Mensalidades em
// atraso: 5", tudo calculado a partir de dados reais (nenhum valor fixo).
// ═══════════════════════════════════════════════════════════════════════════════
export const getPainelTurma = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;

    const [turma] = await queryAsync(
      `
        SELECT
          t.id, t.nome, t.capacidade_maxima, t.class_id, t.sala_id, t.turno_id,
          c.nome as classe_nome,
          sl.numero as sala_numero, sl.capacidade as sala_capacidade,
          tn.nome as turno_nome,
          te.id as professor_titular_id, te.nome as professor_titular_nome
        FROM turmas t
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN salas sl ON sl.id = t.sala_id
        LEFT JOIN turnos tn ON tn.id = t.turno_id
        LEFT JOIN teachers te ON te.id = t.professor_responsavel_id
        WHERE t.id = ? AND t.school_id = ?
      `,
      [turmaId, schoolId]
    );
    if (!turma) return res.status(404).json({ success: false, message: 'Turma não encontrada' });

    // ── ALUNOS ────────────────────────────────────────────────────────────
    const [contagemAlunos] = await queryAsync(
      `SELECT COUNT(*) as total FROM students WHERE turma_id = ? AND school_id = ? AND ativo = 1`,
      [turmaId, schoolId]
    );

    // ── PROFESSORES + DISCIPLINAS (via horários ativos da turma) ───────────
    const professores = await queryAsync(
      `
        SELECT DISTINCT te.id, te.nome
        FROM horarios h
        LEFT JOIN teachers te ON te.id = h.teacher_id
        WHERE h.turma_id = ? AND h.school_id = ? AND h.ativo = 1 AND te.id IS NOT NULL
        ORDER BY te.nome ASC
      `,
      [turmaId, schoolId]
    );
    const disciplinasHorario = await queryAsync(
      `
        SELECT DISTINCT d.id, d.nome, te.nome as professor_nome
        FROM horarios h
        LEFT JOIN disciplinas d ON d.id = h.disciplina_id
        LEFT JOIN teachers te ON te.id = h.teacher_id
        WHERE h.turma_id = ? AND h.school_id = ? AND h.ativo = 1 AND d.id IS NOT NULL
        ORDER BY d.nome ASC
      `,
      [turmaId, schoolId]
    );
    const [totalHorarios] = await queryAsync(
      `SELECT COUNT(*) as total FROM horarios WHERE turma_id = ? AND school_id = ? AND ativo = 1`,
      [turmaId, schoolId]
    );

    // ── DESEMPENHO (média geral da turma, todas as disciplinas/avaliações) ──
    const [mediaTurma] = await queryAsync(
      `SELECT AVG(valor) as media FROM grades WHERE turma_id = ? AND school_id = ?`,
      [turmaId, schoolId]
    );
    // Ranking de disciplinas por média — ajuda a ver onde a turma está mais fraca.
    const mediaPorDisciplina = await queryAsync(
      `
        SELECT d.id, d.nome, AVG(g.valor) as media, COUNT(g.id) as total_avaliacoes
        FROM grades g LEFT JOIN disciplinas d ON d.id = g.disciplina_id
        WHERE g.turma_id = ? AND g.school_id = ?
        GROUP BY d.id, d.nome
        ORDER BY media ASC
      `,
      [turmaId, schoolId]
    );

    // ── FREQUÊNCIA (média de presença da turma, últimos 60 dias) ────────────
    let presencaMedia = null;
    try {
      const [linha] = await queryAsync(
        `
          SELECT
            SUM(CASE WHEN p.status IN ('presente','atraso') THEN 1 ELSE 0 END) as presentes,
            SUM(CASE WHEN p.status != 'justificada' THEN 1 ELSE 0 END) as computaveis
          FROM presencas p
          JOIN students s ON s.id = p.student_id
          WHERE s.turma_id = ? AND p.school_id = ? AND p.data >= CURDATE() - INTERVAL 60 DAY
        `,
        [turmaId, schoolId]
      );
      if (linha?.computaveis > 0) {
        presencaMedia = Number(((linha.presentes / linha.computaveis) * 100).toFixed(1));
      }
    } catch (e) { /* tabela presencas pode ainda não ter registos para esta turma */ }

    // ── FINANCEIRO (mensalidades da turma) ──────────────────────────────────
    const [financeiro] = await queryAsync(
      `
        SELECT
          SUM(CASE WHEN sp.status = 'atrasado' THEN 1 ELSE 0 END) as qtd_atrasadas,
          SUM(CASE WHEN sp.status = 'pendente' THEN 1 ELSE 0 END) as qtd_pendentes,
          SUM(CASE WHEN sp.status = 'atrasado' THEN sp.valor_original + sp.multa ELSE 0 END) as valor_atrasado
        FROM student_payments sp
        JOIN students s ON s.id = sp.student_id
        WHERE s.turma_id = ? AND sp.school_id = ?
      `,
      [turmaId, schoolId]
    );

    // ── OCORRÊNCIAS DISCIPLINARES (últimos 90 dias, da turma) ───────────────
    let ocorrencias = { total: 0, advertencias: 0, suspensoes: 0, elogios: 0 };
    try {
      const [linha] = await queryAsync(
        `
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN o.tipo = 'advertencia' THEN 1 ELSE 0 END) as advertencias,
            SUM(CASE WHEN o.tipo = 'suspensao' THEN 1 ELSE 0 END) as suspensoes,
            SUM(CASE WHEN o.tipo = 'elogio' THEN 1 ELSE 0 END) as elogios
          FROM ocorrencias_disciplinares o
          JOIN students s ON s.id = o.student_id
          WHERE s.turma_id = ? AND o.school_id = ? AND o.data_ocorrencia >= CURDATE() - INTERVAL 90 DAY
        `,
        [turmaId, schoolId]
      );
      ocorrencias = {
        total: linha?.total || 0,
        advertencias: linha?.advertencias || 0,
        suspensoes: linha?.suspensoes || 0,
        elogios: linha?.elogios || 0,
      };
    } catch (e) { /* tabela pode ainda não existir */ }

    // ── OCUPAÇÃO (mesmo critério usado na Controle de Lotação: ≥90% = quase
    // lotada, atingiu/ultrapassou a capacidade = lotada) ─────────────────────
    const totalAlunosAtivos = contagemAlunos?.total || 0;
    const capacidade = turma.capacidade_maxima || 0;
    const percentualOcupacao = capacidade > 0 ? Number(((totalAlunosAtivos / capacidade) * 100).toFixed(1)) : null;
    let statusOcupacao = 'verde';
    if (capacidade > 0 && totalAlunosAtivos >= capacidade) statusOcupacao = 'vermelho';
    else if (capacidade > 0 && percentualOcupacao >= 90) statusOcupacao = 'amarelo';

    res.json({
      success: true,
      turma: {
        id: turma.id,
        nome: turma.nome,
        classe_nome: turma.classe_nome,
        sala_numero: turma.sala_numero,
        sala_capacidade: turma.sala_capacidade,
        turno_nome: turma.turno_nome,
        capacidade_maxima: turma.capacidade_maxima,
        professor_titular_id: turma.professor_titular_id,
        professor_titular_nome: turma.professor_titular_nome,
      },
      alunos: {
        total: totalAlunosAtivos,
        capacidade: turma.capacidade_maxima,
        percentual_ocupacao: percentualOcupacao,
        status_ocupacao: statusOcupacao,
      },
      professores,
      disciplinas: disciplinasHorario,
      total_horarios: totalHorarios?.total || 0,
      desempenho: {
        media_geral: mediaTurma?.media != null ? Number(parseFloat(mediaTurma.media).toFixed(1)) : null,
        por_disciplina: mediaPorDisciplina.map((d) => ({ ...d, media: d.media != null ? Number(parseFloat(d.media).toFixed(1)) : null })),
      },
      frequencia: { percentual_medio: presencaMedia },
      financeiro: {
        qtd_atrasadas: financeiro?.qtd_atrasadas || 0,
        qtd_pendentes: financeiro?.qtd_pendentes || 0,
        valor_atrasado: financeiro?.valor_atrasado || 0,
      },
      ocorrencias,
    });
  } catch (err) {
    console.error('[v0] Erro ao montar painel da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar painel da turma', error: err.message });
  }
};

// GET /schools/:schoolId/turmas/:turmaId/painel/alunos — lista de alunos com
// indicadores individuais rápidos (média, frequência, situação financeira),
// para a sub-aba "Alunos" do painel.
export const getPainelTurmaAlunos = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const alunos = await queryAsync(
      `SELECT id, nome, codigo_aluno, status FROM students WHERE turma_id = ? AND school_id = ? AND ativo = 1 ORDER BY nome ASC`,
      [turmaId, schoolId]
    );
    if (alunos.length === 0) return res.json({ success: true, data: [] });

    const ids = alunos.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');

    const medias = await queryAsync(
      `SELECT student_id, AVG(valor) as media FROM grades WHERE student_id IN (${placeholders}) AND school_id = ? GROUP BY student_id`,
      [...ids, schoolId]
    );
    const mediaPorAluno = Object.fromEntries(medias.map((m) => [m.student_id, m.media != null ? Number(parseFloat(m.media).toFixed(1)) : null]));

    // v117 — `media` acima é só um número bruto de referência (média simples
    // de todas as notas, sem pesos). A situação académica real — a que o
    // aluno vê no boletim, com Testes/Trabalhos/ACP/Exame ponderados e nota
    // mínima da escola — vem daqui, para o Painel da Turma nunca mostrar um
    // veredito (verde/vermelho) que discorde do boletim do próprio aluno.
    let situacoesEscola = {};
    try {
      situacoesEscola = await getSituacoesAcademicasEscola(schoolId);
    } catch (e) {
      console.error('[v0] Falha ao calcular situação académica para o painel da turma:', e.message);
    }

    const financeiros = await queryAsync(
      `SELECT student_id, SUM(CASE WHEN status = 'atrasado' THEN 1 ELSE 0 END) as qtd_atrasadas FROM student_payments WHERE student_id IN (${placeholders}) AND school_id = ? GROUP BY student_id`,
      [...ids, schoolId]
    );
    const atrasoPorAluno = Object.fromEntries(financeiros.map((f) => [f.student_id, f.qtd_atrasadas || 0]));

    res.json({
      success: true,
      data: alunos.map((a) => ({
        ...a,
        media: mediaPorAluno[a.id] ?? null,
        situacao_academica: situacoesEscola[a.id]?.situacao ?? null,
        mensalidades_atrasadas: atrasoPorAluno[a.id] || 0,
      })),
    });
  } catch (err) {
    console.error('[v0] Erro ao listar alunos do painel da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar alunos do painel da turma', error: err.message });
  }
};

// GET /schools/:schoolId/turmas/:turmaId/painel/ocorrencias — lista as
// ocorrências disciplinares reais (não só a contagem) dos alunos desta turma,
// para a aba "Disciplinar" do Perfil 360° da Turma.
export const getPainelTurmaOcorrencias = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const ocorrencias = await queryAsync(
      `
        SELECT o.id, o.tipo, o.titulo, o.descricao, o.data_ocorrencia, o.student_id,
               s.nome as aluno_nome, s.codigo_aluno
        FROM ocorrencias_disciplinares o
        JOIN students s ON s.id = o.student_id
        WHERE s.turma_id = ? AND o.school_id = ?
        ORDER BY o.data_ocorrencia DESC
        LIMIT 200
      `,
      [turmaId, schoolId]
    );
    res.json({ success: true, data: ocorrencias });
  } catch (err) {
    console.error('[v0] Erro ao listar ocorrências do painel da turma:', err);
    // Tabela pode ainda não existir em escolas que nunca lançaram ocorrências.
    res.json({ success: true, data: [] });
  }
};

import db from '../config/db.js';
import { getConfigAvaliacao, calcularMediaDisciplina } from './gradeController.js';
import { calcularResumoFinanceiroAluno } from './mensalidades.controller.js';
import { calcularSituacaoEscolarAluno } from './situacaoEscolarController.js';
import { calcularFrequenciaAluno } from './attendanceController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// Calcula a média geral de um aluno (todas as disciplinas). Por padrão usa o
// ANO LETIVO MAIS RECENTE com notas lançadas; se `academicYearId` for
// informado, filtra em vez disso pelas notas lançadas nesse ano letivo
// específico (ver academicYearController.js) — é o que permite comparar,
// por exemplo, "Aluno João — 2025" com "Aluno João — 2026" sem misturar as
// notas dos dois anos.
// Exportada para ser reutilizada pelo motor de situação escolar (situacaoEscolarController.js),
// garantindo que a média mostrada no perfil e a usada no semáforo de situação são sempre a mesma.
export const calcularMediaGeralAluno = async (schoolId, studentId, config, academicYearId = null) => {
  const notas = await queryAsync(
    `
      SELECT g.disciplina_id, g.valor, g.tipo_avaliacao, g.academic_year_id,
        (SELECT MAX(YEAR(g2.data_avaliacao)) FROM grades g2 WHERE g2.student_id = g.student_id AND g2.school_id = g.school_id) as ano_mais_recente,
        YEAR(g.data_avaliacao) as ano_nota
      FROM grades g WHERE g.school_id = ? AND g.student_id = ?
    `,
    [schoolId, studentId]
  );
  if (notas.length === 0) return null;

  const notasDoAno = academicYearId
    ? notas.filter((n) => String(n.academic_year_id) === String(academicYearId))
    : notas.filter((n) => n.ano_nota === notas[0].ano_mais_recente);
  if (notasDoAno.length === 0) return null;
  const porDisciplina = {};
  notasDoAno.forEach((n) => {
    if (!porDisciplina[n.disciplina_id]) porDisciplina[n.disciplina_id] = { testes: [], trabalhos: [], acp: null, exame: null };
    const grupo = porDisciplina[n.disciplina_id];
    const tipo = String(n.tipo_avaliacao || '');
    if (/^Teste/i.test(tipo)) grupo.testes.push({ valor: parseFloat(n.valor) });
    else if (/^Trabalho/i.test(tipo)) grupo.trabalhos.push({ valor: parseFloat(n.valor) });
    else if (/^ACP/i.test(tipo)) grupo.acp = { valor: parseFloat(n.valor) };
    else if (/^Exame/i.test(tipo)) grupo.exame = { valor: parseFloat(n.valor) };
  });

  const medias = Object.values(porDisciplina)
    .map((disc) => calcularMediaDisciplina(disc, config))
    .filter((m) => m !== null && m !== undefined);
  if (medias.length === 0) return null;
  return parseFloat((medias.reduce((s, m) => s + m, 0) / medias.length).toFixed(2));
};

/**
 * GET /schools/:schoolId/students/:studentId/perfil-completo
 * Reúne, numa só resposta: média geral + ranking na turma, timeline (matrícula,
 * renovações, pagamentos, ocorrências disciplinares) e possíveis irmãos
 * matriculados (alunos ativos que partilham um encarregado com o mesmo telefone).
 */
export const getPerfilCompletoAluno = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    // Ano letivo (ver academicYearController.js) a filtrar. Quando ausente, o
    // comportamento é o de sempre: académico usa o ano mais recente com notas,
    // e financeiro/disciplinar/timeline mostram o histórico completo. Quando
    // presente, TUDO no perfil passa a refletir apenas esse ano letivo — é o
    // que permite comparar "Aluno João — 2025" com "Aluno João — 2026".
    const { academic_year_id: academicYearId } = req.query;

    const [aluno] = await queryAsync(
      `SELECT s.id, s.nome, s.turma_id FROM students s WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
      [studentId, schoolId]
    );
    if (!aluno) return res.status(404).json({ success: false, message: 'Aluno não encontrado' });

    // ── ACADÉMICO: média geral + ranking na turma ──────────────────────────
    const config = await getConfigAvaliacao(schoolId);
    const mediaGeral = await calcularMediaGeralAluno(schoolId, studentId, config, academicYearId);

    let ranking = null;
    let totalTurma = 0;
    if (aluno.turma_id) {
      const colegas = await queryAsync(`SELECT id FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1`, [schoolId, aluno.turma_id]);
      totalTurma = colegas.length;
      const medias = [];
      for (const colega of colegas) {
        const media = await calcularMediaGeralAluno(schoolId, colega.id, config, academicYearId);
        if (media !== null) medias.push({ id: colega.id, media });
      }
      medias.sort((a, b) => b.media - a.media);
      const posicao = medias.findIndex((m) => m.id === parseInt(studentId, 10));
      if (posicao !== -1) ranking = posicao + 1;
    }

    // ── DISCIPLINAR: últimas ocorrências ────────────────────────────────────
    let disciplinar = [];
    try {
      disciplinar = await queryAsync(
        `SELECT * FROM ocorrencias_disciplinares WHERE school_id = ? AND student_id = ? ${academicYearId ? 'AND academic_year_id = ?' : ''} ORDER BY data_ocorrencia DESC LIMIT 10`,
        academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
      );
    } catch (e) { /* tabela pode ainda não existir */ }

    // ── TIMELINE: matrícula/renovações + pagamentos + disciplinar ──────────
    let renovacoes = [];
    try {
      renovacoes = await queryAsync(
        `SELECT id, turma_nome_anterior, turma_nome_nova, situacao_academica, origem, created_at as data
         FROM enrollment_history WHERE school_id = ? AND student_id = ? ${academicYearId ? 'AND academic_year_id = ?' : ''} ORDER BY created_at DESC LIMIT 10`,
        academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
      );
    } catch (e) { /* ignore */ }

    let pagamentos = [];
    try {
      pagamentos = await queryAsync(
        `SELECT id, valor_pago, data_pagamento as data FROM student_payments
         WHERE school_id = ? AND student_id = ? AND status = 'pago' ${academicYearId ? 'AND academic_year_id = ?' : ''} ORDER BY data_pagamento DESC LIMIT 10`,
        academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
      );
    } catch (e) { /* ignore */ }

    // ── NOTAS: últimos lançamentos (por disciplina/data, não uma linha por nota
    // individual, para não poluir a timeline com dezenas de eventos parecidos) ─
    let notasLancadas = [];
    try {
      notasLancadas = await queryAsync(
        `
          SELECT MAX(g.created_at) as data, g.disciplina_id, d.nome as disciplina_nome, COUNT(*) as qtd
          FROM grades g LEFT JOIN disciplinas d ON d.id = g.disciplina_id
          WHERE g.school_id = ? AND g.student_id = ? ${academicYearId ? 'AND g.academic_year_id = ?' : ''}
          GROUP BY DATE(g.created_at), g.disciplina_id, d.nome
          ORDER BY data DESC LIMIT 10
        `,
        academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
      );
    } catch (e) { /* ignore */ }

    // ── DOCUMENTOS: uploads recentes ────────────────────────────────────────
    let documentosRecentes = [];
    try {
      documentosRecentes = await queryAsync(
        `SELECT id, tipo, titulo, created_at as data FROM student_documentos WHERE school_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 10`,
        [schoolId, studentId]
      );
    } catch (e) { /* ignore */ }

    const timeline = [
      ...renovacoes.map((r) => ({
        tipo: 'matricula',
        data: r.data,
        titulo: r.turma_nome_anterior ? `Renovação: ${r.turma_nome_anterior} → ${r.turma_nome_nova}` : `Matrícula na turma ${r.turma_nome_nova}`,
        detalhe: r.situacao_academica ? `Situação: ${r.situacao_academica}` : null,
      })),
      ...pagamentos.map((p) => ({
        tipo: 'pagamento',
        data: p.data,
        titulo: `Pagamento de ${parseFloat(p.valor_pago).toFixed(2)} MZN`,
        detalhe: null,
      })),
      ...disciplinar.map((d) => ({
        tipo: d.tipo,
        data: d.data_ocorrencia,
        titulo: d.titulo,
        detalhe: d.descricao,
      })),
      ...notasLancadas.map((n) => ({
        tipo: 'nota',
        data: n.data,
        titulo: `Nota lançada — ${n.disciplina_nome || 'Disciplina'}`,
        detalhe: n.qtd > 1 ? `${n.qtd} avaliações lançadas nesse dia` : null,
      })),
      ...documentosRecentes.map((doc) => ({
        tipo: 'documento',
        data: doc.data,
        titulo: `Documento atualizado — ${doc.titulo || doc.tipo}`,
        detalhe: null,
      })),
    ].filter((e) => e.data).sort((a, b) => new Date(b.data) - new Date(a.data));

    // ── FINANCEIRO: resumo completo (pago, pendente, atrasado, histórico) ──
    let financeiro = { situacao: 'em_dia', totalPago: 0, totalPendente: 0, totalAtrasado: 0, proximoVencimento: null, cobrancasPendentesOuAtrasadas: 0, historico: [] };
    try {
      financeiro = await calcularResumoFinanceiroAluno(schoolId, studentId, { academicYearId });
    } catch (e) {
      console.error('[v0] Aviso: não foi possível carregar o financeiro no perfil completo:', e.message);
    }

    // ── SITUAÇÃO ESCOLAR: motor que cruza académico + frequência + disciplinar
    // + financeiro numa conclusão só (🟢 regular / 🟡 atenção / 🔴 crítico).
    // Reaproveita a média geral, a config de avaliação e o financeiro já
    // calculados acima, para não repetir consultas à base de dados.
    let situacaoEscolar = null;
    try {
      situacaoEscolar = await calcularSituacaoEscolarAluno(schoolId, studentId, {
        config,
        mediaGeral,
        financeiro,
        academicYearId,
      });
    } catch (e) {
      console.error('[v0] Aviso: não foi possível calcular a situação escolar no perfil completo:', e.message);
    }

    // ── FREQUÊNCIA: resumo rápido para a aba Resumo (a aba Frequência tem o
    // detalhe completo, com evolução mensal e registos) ────────────────────
    let frequencia = { percentual: null, risco_exclusao: 'baixo' };
    try {
      const { stats } = await calcularFrequenciaAluno(schoolId, studentId, { academicYearId });
      frequencia = { percentual: stats.percentualFrequencia, risco_exclusao: stats.risco_exclusao };
    } catch (e) { /* tabela presencas pode ainda não ter registos */ }

    // ── FAMÍLIA: outros alunos ativos com encarregado de mesmo telefone ────
    let familia = [];
    try {
      familia = await queryAsync(
        `
          SELECT DISTINCT s2.id, s2.nome, s2.codigo_aluno, t.nome as turma_nome
          FROM guardians g1
          INNER JOIN guardians g2 ON g2.telefone = g1.telefone AND g2.telefone IS NOT NULL AND g2.telefone != '' AND g2.student_id != g1.student_id
          INNER JOIN students s2 ON s2.id = g2.student_id
          LEFT JOIN turmas t ON t.id = s2.turma_id
          WHERE g1.student_id = ? AND s2.school_id = ? AND s2.ativo = 1
        `,
        [studentId, schoolId]
      );
    } catch (e) { /* ignore */ }

    res.json({
      success: true,
      academico: { media_geral: mediaGeral, ranking_turma: ranking, total_turma: totalTurma },
      disciplinar,
      timeline: timeline.slice(0, 20),
      familia,
      financeiro,
      frequencia,
      situacao_escolar: situacaoEscolar,
    });
  } catch (err) {
    console.error('[v0] Erro ao montar perfil completo do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar perfil completo do aluno', error: err.message });
  }
};

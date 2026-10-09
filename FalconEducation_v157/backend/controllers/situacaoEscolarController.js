import db from '../config/db.js';
import { getConfigAvaliacao } from './gradeController.js';
import { calcularMediaGeralAluno } from './perfilAlunoController.js';
import { calcularFrequenciaAluno } from './attendanceController.js';
import { calcularResumoFinanceiroAluno } from './mensalidades.controller.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOTOR DE SITUAÇÃO ESCOLAR
// ─────────────────────────────────────────────────────────────────────────────
// Até aqui, cada módulo (Notas, Frequência, Financeiro, Disciplinar, Renovação)
// funcionava isoladamente: o utilizador tinha de abrir cada aba para perceber
// se um aluno estava "bem" ou "em risco". Este motor cruza os quatro sinais
// automaticamente e devolve uma conclusão só — 🟢 regular / 🟡 atenção / 🔴 crítico
// — com os motivos por trás dela, para ser usado no perfil do aluno, na lista
// da turma e num painel de alerta no dashboard da escola.
// ═══════════════════════════════════════════════════════════════════════════════

const ESCALA_MAX = 20; // escala de avaliação usada em todo o sistema (0–20)
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Pesos usados na pontuação geral (0–100). Podem ser ajustados aqui no futuro
// se a escola quiser dar mais ou menos peso a alguma área.
const PESOS = { academico: 0.35, frequencia: 0.25, disciplinar: 0.20, financeiro: 0.20 };

/**
 * Função PURA (sem acesso à base de dados): recebe os quatro sinais já
 * calculados e devolve a conclusão do semáforo. Extraída à parte para poder
 * ser reutilizada tanto pelo motor "aluno a aluno" como por uma futura
 * listagem em lote, sem repetir a lógica de decisão em dois sítios.
 */
export const avaliarSituacaoEscolar = ({
  mediaGeral = null,
  notaMinimaAprovacao = 10,
  frequenciaPercentual = null,
  ocorrenciasNegativas = 0,
  ocorrenciasElogios = 0,
  financeiro = { situacao: 'em_dia', cobrancasEmAtraso: 0 },
}) => {
  const fatores = [];
  const alertasCriticos = [];
  const alertasAtencao = [];

  // ── 1. ACADÉMICO ─────────────────────────────────────────────────────────
  let scoreAcademico = null;
  if (mediaGeral !== null && mediaGeral !== undefined) {
    scoreAcademico = clamp((mediaGeral / ESCALA_MAX) * 100, 0, 100);
    const nivel = mediaGeral < notaMinimaAprovacao ? 'critico' : mediaGeral < notaMinimaAprovacao + 3 ? 'atencao' : 'bom';
    fatores.push({
      area: 'academico', label: 'Média geral', valor: mediaGeral, nivel,
      mensagem: `Média geral de ${mediaGeral.toFixed(1)} valores (mínimo de aprovação: ${notaMinimaAprovacao})`,
    });
    if (nivel === 'critico') alertasCriticos.push(`Média abaixo do mínimo de aprovação (${mediaGeral.toFixed(1)} de ${notaMinimaAprovacao})`);
    else if (nivel === 'atencao') alertasAtencao.push(`Média próxima do limite de aprovação (${mediaGeral.toFixed(1)})`);
  } else {
    fatores.push({ area: 'academico', label: 'Média geral', valor: null, nivel: 'sem_dados', mensagem: 'Ainda sem notas lançadas' });
  }

  // ── 2. FREQUÊNCIA ────────────────────────────────────────────────────────
  let scoreFrequencia = null;
  if (frequenciaPercentual !== null && frequenciaPercentual !== undefined) {
    scoreFrequencia = clamp(frequenciaPercentual, 0, 100);
    const nivel = frequenciaPercentual < 75 ? 'critico' : frequenciaPercentual < 90 ? 'atencao' : 'bom';
    fatores.push({
      area: 'frequencia', label: 'Frequência', valor: frequenciaPercentual, nivel,
      mensagem: `${frequenciaPercentual.toFixed(1)}% de presença`,
    });
    if (nivel === 'critico') alertasCriticos.push(`Frequência baixa (${frequenciaPercentual.toFixed(1)}%)`);
    else if (nivel === 'atencao') alertasAtencao.push(`Frequência a precisar de atenção (${frequenciaPercentual.toFixed(1)}%)`);
  } else {
    fatores.push({ area: 'frequencia', label: 'Frequência', valor: null, nivel: 'sem_dados', mensagem: 'Ainda sem registos de presença' });
  }

  // ── 3. DISCIPLINAR ───────────────────────────────────────────────────────
  // Suspensão pesa o dobro de uma advertência; elogios abonam um pouco a favor do aluno.
  const scoreDisciplinar = clamp(100 - ocorrenciasNegativas * 25 + ocorrenciasElogios * 5, 0, 100);
  const nivelDisciplinar = ocorrenciasNegativas >= 3 ? 'critico' : ocorrenciasNegativas >= 1 ? 'atencao' : 'bom';
  fatores.push({
    area: 'disciplinar', label: 'Comportamento', valor: ocorrenciasNegativas, nivel: nivelDisciplinar,
    mensagem: ocorrenciasNegativas === 0 ? 'Sem ocorrências disciplinares' : `${ocorrenciasNegativas} ocorrência(s) disciplinar(es)`,
  });
  if (nivelDisciplinar === 'critico') alertasCriticos.push(`${ocorrenciasNegativas} ocorrências disciplinares registadas`);
  else if (nivelDisciplinar === 'atencao') alertasAtencao.push(`${ocorrenciasNegativas} ocorrência(s) disciplinar(es) registada(s)`);

  // ── 4. FINANCEIRO ────────────────────────────────────────────────────────
  const cobrancasEmAtraso = financeiro?.cobrancasEmAtraso ?? 0;
  const situacaoFinanceira = financeiro?.situacao ?? 'em_dia';
  const scoreFinanceiro = situacaoFinanceira === 'em_atraso' ? (cobrancasEmAtraso >= 3 ? 10 : 40)
    : situacaoFinanceira === 'pendente' ? 70 : 100;
  const nivelFinanceiro = situacaoFinanceira === 'em_atraso' ? 'critico' : situacaoFinanceira === 'pendente' ? 'atencao' : 'bom';
  fatores.push({
    area: 'financeiro', label: 'Mensalidades', valor: situacaoFinanceira, nivel: nivelFinanceiro,
    mensagem: nivelFinanceiro === 'critico' ? `${cobrancasEmAtraso} mensalidade(s) em atraso`
      : nivelFinanceiro === 'atencao' ? 'Mensalidade(s) pendente(s)' : 'Mensalidades em dia',
  });
  if (nivelFinanceiro === 'critico') alertasCriticos.push(`${cobrancasEmAtraso} mensalidade(s) em atraso`);
  else if (nivelFinanceiro === 'atencao') alertasAtencao.push('Mensalidade(s) pendente(s)');

  // ── PONTUAÇÃO PONDERADA (0–100) ──────────────────────────────────────────
  // Áreas "sem dados" (ex.: aluno ainda sem notas) não entram no cálculo, para
  // não penalizar quem simplesmente ainda não tem informação lançada.
  const disponiveis = [];
  if (scoreAcademico !== null) disponiveis.push([scoreAcademico, PESOS.academico]);
  if (scoreFrequencia !== null) disponiveis.push([scoreFrequencia, PESOS.frequencia]);
  disponiveis.push([scoreDisciplinar, PESOS.disciplinar]);
  disponiveis.push([scoreFinanceiro, PESOS.financeiro]);
  const pesoTotal = disponiveis.reduce((s, [, p]) => s + p, 0);
  const pontuacao = pesoTotal > 0
    ? Math.round(disponiveis.reduce((s, [v, p]) => s + v * p, 0) / pesoTotal)
    : 100;

  // ── CONCLUSÃO FINAL ───────────────────────────────────────────────────────
  // Regra principal: a pontuação ponderada decide o semáforo (≥80 regular,
  // 55–79 atenção, <55 crítico). Um único alerta leve (ex.: 1 ocorrência
  // disciplinar num aluno com médias e frequência boas) não deve, sozinho,
  // rebaixar um bom aluno — por isso NÃO forçamos "atenção" apenas por existir
  // 1 alerta leve. Já um alerta GRAVE (ex.: reprovado, 3+ mensalidades em
  // atraso) força sempre "crítico", mesmo que a pontuação global disfarce o
  // problema por as outras áreas estarem boas — é o "gatilho rígido" que
  // impede um problema sério de passar despercebido.
  let status = 'regular';
  if (alertasCriticos.length > 0 || pontuacao < 55) status = 'critico';
  else if (pontuacao < 80 || alertasAtencao.length >= 2) status = 'atencao';

  const cor = status === 'critico' ? 'vermelho' : status === 'atencao' ? 'amarelo' : 'verde';
  const emoji = status === 'critico' ? '🔴' : status === 'atencao' ? '🟡' : '🟢';
  const resumo = status === 'critico'
    ? 'Aluno em situação de atenção — vários indicadores fora do esperado.'
    : status === 'atencao'
    ? 'Aluno com pontos a acompanhar.'
    : 'Aluno academicamente regular.';

  return {
    status,      // 'regular' | 'atencao' | 'critico'
    cor,         // 'verde' | 'amarelo' | 'vermelho'
    emoji,
    pontuacao,   // 0–100, útil para ordenar listas por risco
    resumo,
    alertas: [...alertasCriticos, ...alertasAtencao],
    fatores,
  };
};

/**
 * Orquestrador: junta os quatro módulos (Notas, Frequência, Disciplinar,
 * Financeiro) para UM aluno e devolve a conclusão do semáforo. Aceita valores
 * já calculados (ex.: pelo perfil completo do aluno) para evitar repetir
 * consultas à base de dados quando o chamador já os tem em mãos.
 */
export const calcularSituacaoEscolarAluno = async (schoolId, studentId, dadosConhecidos = {}) => {
  const config = dadosConhecidos.config || await getConfigAvaliacao(schoolId);
  const academicYearId = dadosConhecidos.academicYearId || null;

  // v113 — antes, uma falha aqui virava `[]`, e como "sem ocorrências" e
  // "não consegui consultar" produzem o mesmo número (0 pontos negativos),
  // o semáforo do aluno podia ficar mais verde do que deveria por causa de
  // uma falha de consulta. Agora a falha é registada e sinalizada no
  // resultado (`situacao.avisos`), sem quebrar o cálculo dos outros fatores.
  let ocorrenciasFalhou = false;
  const [mediaGeral, frequencia, ocorrenciasPorTipo, financeiro] = await Promise.all([
    dadosConhecidos.mediaGeral !== undefined ? dadosConhecidos.mediaGeral : calcularMediaGeralAluno(schoolId, studentId, config, academicYearId),
    dadosConhecidos.frequencia || calcularFrequenciaAluno(schoolId, studentId, { academicYearId }),
    queryAsync(
      `SELECT tipo, COUNT(*) as total FROM ocorrencias_disciplinares WHERE school_id = ? AND student_id = ? ${academicYearId ? 'AND academic_year_id = ?' : ''} GROUP BY tipo`,
      academicYearId ? [schoolId, studentId, academicYearId] : [schoolId, studentId]
    ).catch((e) => {
      console.error('[v0] Falha ao consultar ocorrências disciplinares para o semáforo:', e.message);
      ocorrenciasFalhou = true;
      return [];
    }),
    dadosConhecidos.financeiro || calcularResumoFinanceiroAluno(schoolId, studentId, { academicYearId }),
  ]);

  const ocorrenciasMap = Object.fromEntries(ocorrenciasPorTipo.map((o) => [o.tipo, o.total]));
  const ocorrenciasNegativas = (ocorrenciasMap.advertencia || 0) + (ocorrenciasMap.suspensao || 0) * 2;
  const ocorrenciasElogios = ocorrenciasMap.elogio || 0;

  // O resumo financeiro devolve o histórico completo; contamos aqui quantas
  // cobranças estão efetivamente em atraso (inclui "pendente" já vencida).
  const hoje = new Date().toISOString().split('T')[0];
  const cobrancasEmAtraso = (financeiro.historico || []).filter((h) => {
    if (h.status === 'atrasado') return true;
    if (h.status === 'pendente' && h.data_vencimento) {
      const venc = h.data_vencimento instanceof Date
        ? h.data_vencimento.toISOString().split('T')[0]
        : String(h.data_vencimento).split('T')[0];
      return venc < hoje;
    }
    return false;
  }).length;

  const situacao = avaliarSituacaoEscolar({
    mediaGeral,
    notaMinimaAprovacao: config.nota_minima_aprovacao,
    frequenciaPercentual: frequencia?.stats?.percentualFrequencia ?? null,
    ocorrenciasNegativas,
    ocorrenciasElogios,
    financeiro: { situacao: financeiro.situacao, cobrancasEmAtraso },
  });
  if (ocorrenciasFalhou) {
    situacao.avisos = [...(situacao.avisos || []), 'Não foi possível consultar as ocorrências disciplinares — o pontuação pode estar incompleta.'];
  }
  return situacao;
};

/**
 * GET /schools/:schoolId/students/:studentId/situacao-escolar
 * Endpoint autónomo do semáforo — útil para widgets que só precisam da
 * conclusão (ex.: um badge na lista de alunos) sem carregar o perfil inteiro.
 */
export const getSituacaoEscolarAluno = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { academic_year_id } = req.query;
    const [aluno] = await queryAsync(`SELECT id, nome FROM students WHERE id = ? AND school_id = ? LIMIT 1`, [studentId, schoolId]);
    if (!aluno) return res.status(404).json({ success: false, message: 'Aluno não encontrado' });

    const situacao = await calcularSituacaoEscolarAluno(schoolId, studentId, { academicYearId: academic_year_id });
    res.json({ success: true, aluno: { id: aluno.id, nome: aluno.nome }, situacao });
  } catch (err) {
    console.error('[v0] Erro ao calcular situação escolar do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular situação escolar', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/turmas/:turmaId/situacao-escolar
 * Situação de TODOS os alunos ativos de uma turma, ordenada dos mais críticos
 * para os mais regulares — pensada para o professor/diretor de turma abrir e
 * ver imediatamente quem precisa de atenção.
 */
export const getSituacaoEscolarTurma = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const alunos = await queryAsync(
      `SELECT id, nome, codigo_aluno FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1 ORDER BY nome ASC`,
      [schoolId, turmaId]
    );

    const config = await getConfigAvaliacao(schoolId);
    const resultado = [];
    for (const aluno of alunos) {
      const situacao = await calcularSituacaoEscolarAluno(schoolId, aluno.id, { config });
      resultado.push({ aluno: { id: aluno.id, nome: aluno.nome, codigo_aluno: aluno.codigo_aluno }, situacao });
    }
    resultado.sort((a, b) => a.situacao.pontuacao - b.situacao.pontuacao);

    const resumo = {
      total: resultado.length,
      criticos: resultado.filter((r) => r.situacao.status === 'critico').length,
      atencao: resultado.filter((r) => r.situacao.status === 'atencao').length,
      regulares: resultado.filter((r) => r.situacao.status === 'regular').length,
    };

    res.json({ success: true, resumo, alunos: resultado });
  } catch (err) {
    console.error('[v0] Erro ao calcular situação escolar da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular situação escolar da turma', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/situacao-escolar/painel
 * Painel de alerta ao nível da escola inteira: contagem por semáforo +
 * ranking dos alunos mais críticos, para ser usado como widget no Dashboard.
 * Aceita ?limite= para controlar quantos alunos críticos vêm na lista (padrão 15).
 */
export const getPainelSituacaoEscolar = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const limite = Math.min(parseInt(req.query.limite, 10) || 15, 50);

    // Nota de performance: o cálculo é feito aluno a aluno (várias consultas
    // por aluno), pelo que este painel é pensado para escolas de porte normal
    // (algumas centenas de alunos). Para escolas muito grandes, o limite abaixo
    // evita que o pedido demore demasiado — se for preciso ver mais alunos em
    // detalhe, usar o endpoint por turma (situacao-escolar por turma) em vez deste.
    const alunos = await queryAsync(
      `SELECT s.id, s.nome, s.codigo_aluno, t.nome as turma_nome
       FROM students s LEFT JOIN turmas t ON t.id = s.turma_id
       WHERE s.school_id = ? AND s.ativo = 1 ORDER BY s.nome ASC LIMIT 500`,
      [schoolId]
    );

    const config = await getConfigAvaliacao(schoolId);
    const resultado = [];
    for (const aluno of alunos) {
      const situacao = await calcularSituacaoEscolarAluno(schoolId, aluno.id, { config });
      resultado.push({
        aluno: { id: aluno.id, nome: aluno.nome, codigo_aluno: aluno.codigo_aluno, turma_nome: aluno.turma_nome },
        situacao,
      });
    }

    const resumo = {
      total: resultado.length,
      criticos: resultado.filter((r) => r.situacao.status === 'critico').length,
      atencao: resultado.filter((r) => r.situacao.status === 'atencao').length,
      regulares: resultado.filter((r) => r.situacao.status === 'regular').length,
    };

    const alunosEmAlerta = resultado
      .filter((r) => r.situacao.status !== 'regular')
      .sort((a, b) => a.situacao.pontuacao - b.situacao.pontuacao)
      .slice(0, limite);

    res.json({ success: true, resumo, alunos_em_alerta: alunosEmAlerta });
  } catch (err) {
    console.error('[v0] Erro ao gerar painel de situação escolar:', err);
    res.status(500).json({ success: false, message: 'Erro ao gerar painel de situação escolar', error: err.message });
  }
};

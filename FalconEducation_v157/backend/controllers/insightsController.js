import db from '../config/db.js';
import { calcularSinaisEscola, ensureTabelas as ensureTabelasDashboard } from './dashboardController.js';
import {
  VALORES_PADRAO_RADAR, getRadarConfig, salvarRadarConfig, classificarPercentual, percentual,
} from '../services/radarConfigService.js';
import { getConfigAvaliacao, getFaltasMaxPPF } from './gradeController.js';
import { ensurePresencasTableExists } from './attendanceController.js';
import { ensurePaymentColumnsExist } from '../services/financialStatusService.js';
import { getAnoLetivoAtivo } from '../services/academicYearService.js';
import { verificarJanelaRenovacaoAberta } from '../services/enrollmentStatusService.js';
import { getSituacoesAcademicasEscola } from '../services/academicStatusService.js';
import { executarSimulacao } from '../services/simuladorService.js';
import {
  listarTiposDisponiveis, listarRegras, criarRegra, atualizarRegra, removerRegra, executarTodasRegras,
} from '../services/automationService.js';
import { gerarRelatorioExecutivo, gerarRelatorioExecutivoPDF } from '../services/relatorioExecutivoService.js';

// v153 — a situação geral do aluno usa DUAS terminologias, conforme a classe
// tenha ou não exame (ver configuracaoAcademicaService.js e
// mozaEvaluationRules.js): "Aprovado"/"Reprovado" nas classes com exame,
// "Transita"/"Não Transita" nas classes sem exame. Antes desta correção, os
// sinais agregados da escola só reconheciam a forma literal com exame, pelo
// que numa escola com classes sem exame (a maioria) o Radar/Insights
// SUBESTIMAVA os alunos em risco e a taxa de aprovação projetada ignorava
// todos os alunos que transitaram.
const SITUACOES_APROVACAO = new Set(['Aprovado', 'Transita', 'Dispensado']);
const SITUACOES_REPROVACAO = new Set(['Reprovado', 'Não Transita']);

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FALCON INSIGHTS — Central de Inteligência da Escola
// ─────────────────────────────────────────────────────────────────────────────
// Não inventa nenhum sinal novo do zero: reorganiza e cruza dados que já são
// calculados noutros pontos do sistema (Central de Alertas, PPF/risco de
// exclusão, situação financeira, avaliação) para responder a UMA pergunta:
// "o que está a acontecer na escola e o que precisa da minha atenção AGORA?"
// ═══════════════════════════════════════════════════════════════════════════════

const normalizar = (texto) => String(texto || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim();

const arredondar = (n, casas = 1) => Number.isFinite(n) ? Number(n.toFixed(casas)) : 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO DO RADAR DA ESCOLA — v113 (extraída para radarConfigService.js
// no v114, para ser partilhada com o dashboardController.js — ver esse
// ficheiro para o comentário completo sobre os limiares não-universais).
// ═══════════════════════════════════════════════════════════════════════════════

// GET /schools/:schoolId/insights/radar-config
export const getRadarConfigEndpoint = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const config = await getRadarConfig(schoolId);
    res.json({ success: true, data: config, padrao: VALORES_PADRAO_RADAR });
  } catch (err) {
    console.error('[v0] Erro ao buscar configuração do Radar da Escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração do Radar da Escola', error: err.message });
  }
};

// PUT /schools/:schoolId/insights/radar-config — body: qualquer subconjunto dos campos de VALORES_PADRAO_RADAR
export const salvarRadarConfigEndpoint = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const novo = await salvarRadarConfig(schoolId, req.body);
    res.json({ success: true, data: novo });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[v0] Erro ao salvar configuração do Radar da Escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração do Radar da Escola', error: err.message });
  }
};

/**
 * Compara a média das notas lançadas (valor bruto, não a média ponderada
 * oficial da disciplina) entre dois períodos consecutivos de 45 dias, por
 * turma — para detetar uma TENDÊNCIA de queda antes que vire reprovação em
 * massa. É deliberadamente mais simples do que calcularMediaGeralAluno (que
 * pesa testes/trabalhos/ACP/exame): aqui o objetivo é velocidade de sinal,
 * não o boletim oficial do aluno.
 */
export const calcularQuedaDesempenho = async (schoolId) => {
  let linhas = [];
  try {
    linhas = await queryAsync(
      `
        SELECT
          t.id as turma_id, t.nome as turma_nome, d.nome as disciplina_nome,
          AVG(CASE WHEN g.data_avaliacao >= CURDATE() - INTERVAL 45 DAY THEN g.valor END) as media_atual,
          COUNT(CASE WHEN g.data_avaliacao >= CURDATE() - INTERVAL 45 DAY THEN 1 END) as qtd_atual,
          AVG(CASE WHEN g.data_avaliacao < CURDATE() - INTERVAL 45 DAY AND g.data_avaliacao >= CURDATE() - INTERVAL 90 DAY THEN g.valor END) as media_anterior,
          COUNT(CASE WHEN g.data_avaliacao < CURDATE() - INTERVAL 45 DAY AND g.data_avaliacao >= CURDATE() - INTERVAL 90 DAY THEN 1 END) as qtd_anterior
        FROM grades g
        INNER JOIN students s ON s.id = g.student_id
        INNER JOIN turmas t ON t.id = s.turma_id
        LEFT JOIN disciplinas d ON d.id = g.disciplina_id
        WHERE g.school_id = ? AND g.data_avaliacao >= CURDATE() - INTERVAL 90 DAY
        GROUP BY t.id, t.nome, d.id, d.nome
        HAVING qtd_atual >= 3 AND qtd_anterior >= 3
      `,
      [schoolId]
    );
  } catch (e) { /* tabela grades/disciplinas pode ainda não ter dados suficientes nos últimos 90 dias */ }

  const porTurma = {};
  linhas.forEach((l) => {
    if (!porTurma[l.turma_id]) porTurma[l.turma_id] = { turma_id: l.turma_id, turma_nome: l.turma_nome, disciplinas: [] };
    const variacao = l.media_anterior > 0 ? ((l.media_atual - l.media_anterior) / l.media_anterior) * 100 : 0;
    porTurma[l.turma_id].disciplinas.push({
      disciplina: l.disciplina_nome || 'Disciplina', media_atual: arredondar(l.media_atual, 2),
      media_anterior: arredondar(l.media_anterior, 2), variacao_pct: arredondar(variacao),
    });
  });

  return Object.values(porTurma)
    .map((turma) => {
      const mediaAtualPonderada = turma.disciplinas.reduce((s, d) => s + d.media_atual, 0) / turma.disciplinas.length;
      const mediaAnteriorPonderada = turma.disciplinas.reduce((s, d) => s + d.media_anterior, 0) / turma.disciplinas.length;
      const variacaoGeral = mediaAnteriorPonderada > 0 ? ((mediaAtualPonderada - mediaAnteriorPonderada) / mediaAnteriorPonderada) * 100 : 0;
      const disciplinasCriticas = [...turma.disciplinas].sort((a, b) => a.variacao_pct - b.variacao_pct).slice(0, 2).filter((d) => d.variacao_pct < 0);
      return {
        turma_id: turma.turma_id, turma_nome: turma.turma_nome,
        media_atual: arredondar(mediaAtualPonderada, 2), media_anterior: arredondar(mediaAnteriorPonderada, 2),
        variacao_pct: arredondar(variacaoGeral), disciplinas_criticas: disciplinasCriticas,
      };
    })
    .filter((t) => t.variacao_pct <= -10) // só entra como "queda" se caiu 10% ou mais
    .sort((a, b) => a.variacao_pct - b.variacao_pct);
};

/**
 * Conta quantos alunos ativos estão, hoje, em risco académico — usando a
 * mesma classificação por disciplina (Testes/Trabalhos/ACP/Exame, com pesos
 * e nota mínima configurados pela escola) do boletim, da Pauta Oficial e da
 * renovação de matrícula, via getSituacoesAcademicasEscola() em
 * academicStatusService.js. "Em risco" = situação geral 'Reprovado' (já
 * reprovou nalguma disciplina), 'Vai a Exame' (ainda não garantiu aprovação)
 * ou 'Excluído' (excedeu o limite de faltas) — os três casos em que o aluno
 * corre risco real de não progredir de classe. 'Incompleto' e 'Sem notas'
 * NÃO contam como risco (dados insuficientes para julgar, não indício de
 * mau desempenho — ver v115/v116).
 *
 * v117 — antes, isto era uma média BRUTA (AVG(g.valor), sem pesos) contra a
 * nota mínima; podia divergir do boletim do próprio aluno. Ver
 * CHANGELOG_v117.md.
 */
export const contarAlunosRiscoReprovacao = async (schoolId) => {
  const situacoes = await getSituacoesAcademicasEscola(schoolId);
  // v153 — inclui "Não Transita" (equivalente a "Reprovado" nas classes sem
  // exame) via SITUACOES_REPROVACAO; sem isto, alunos reprovados em classes
  // sem exame nunca entravam na contagem de risco.
  const EM_RISCO = new Set([...SITUACOES_REPROVACAO, 'Vai a Exame', 'Excluído']);
  return Object.values(situacoes).filter((s) => EM_RISCO.has(s.situacao)).length;
};

/**
 * Radar da Escola: um semáforo por área, cruzando os sinais já calculados em
 * calcularSinaisEscola() com os totais de cada população, para não julgar um
 * número absoluto fora de contexto (10 mensalidades atrasadas é grave numa
 * escola de 40 alunos e irrelevante numa de 2000).
 */
const calcularRadarEscola = async (schoolId, sinais, quedaDesempenho, radarConfig) => {
  const { brutos } = sinais;
  // v113 — sinais que vieram de calcularSinaisEscola() e falharam de verdade
  // (não "tabela ainda não migrada"). Uma área cujo cálculo depende de um
  // sinal falho passa a mostrar 'indisponivel' em vez de herdar o zero e sair como
  // 'ok' (verde) — ver AUDITORIA_erro-vira-zero_v113.md.
  const falhas = sinais.falhas || [];
  const algumaFalha = (...chaves) => chaves.some((c) => falhas.includes(c));
  // v113 — os limiares abaixo (ex.: "15% = crítico") não são universais: uma
  // escola de 2000 alunos e uma de 6 não podem usar o mesmo corte. `config`
  // vem de radar_config (getRadarConfig), configurável por escola em
  // Configurações → Radar da Escola; os valores por omissão preservam
  // exatamente o comportamento anterior. Ver AUDITORIA_erro-vira-zero_v113.md.
  const config = radarConfig;

  const [[totaisRow]] = await Promise.all([
    queryAsync(
      `SELECT
        (SELECT COUNT(*) FROM students WHERE school_id = ? AND ativo = 1) as total_alunos,
        (SELECT COUNT(*) FROM teachers WHERE school_id = ? AND ativo = 1) as total_professores,
        (SELECT COUNT(*) FROM turmas WHERE school_id = ? AND ativa = 1) as total_turmas
      `,
      [schoolId, schoolId, schoolId]
    ),
  ]);
  const totalAlunos = totaisRow?.total_alunos || 0;
  const totalProfessores = totaisRow?.total_professores || 0;
  const totalTurmas = totaisRow?.total_turmas || 0;
  // v114 — `percentual`/`classificar` agora vêm de radarConfigService.js
  // (partilhados com a Central de Alertas em dashboardController.js), em
  // vez de redefinidos localmente aqui.
  const classificar = classificarPercentual;

  // ── Alunos: frequência baixa + documentação incompleta ──────────────────
  const pctFreqBaixa = percentual(brutos.frequenciaBaixaRow?.qtd || 0, totalAlunos);
  const pctDocIncompleta = percentual(brutos.docIncompletaRow?.qtd || 0, totalAlunos);
  const alunosStatus = algumaFalha('frequencia_baixa', 'documentacao_incompleta')
    ? 'indisponivel' : classificar(Math.max(pctFreqBaixa, pctDocIncompleta), pctFreqBaixa + pctDocIncompleta, config.limite_critico_alunos, config.limite_atencao_alunos);

  // ── Professores: sem horário + documentos a vencer ──────────────────────
  const pctSemHorario = percentual(brutos.professoresSemHorarioRow?.qtd || 0, totalProfessores);
  const professoresStatus = algumaFalha('professores_sem_horario', 'documentos_professor_vencendo')
    ? 'indisponivel' : classificar(pctSemHorario, pctSemHorario + (brutos.documentosProfessorVencendoRow?.qtd || 0), config.limite_critico_professores, config.limite_atencao_professores);

  // ── Académico: turmas com queda de desempenho + risco de reprovação ─────
  let alunosRiscoReprovacao = 0;
  let falhouAcademico = false;
  try {
    alunosRiscoReprovacao = await contarAlunosRiscoReprovacao(schoolId);
  } catch (e) {
    console.error("[v0] Falha ao calcular risco de reprovação para o Radar da Escola:", e.message);
    falhouAcademico = true;
  }
  const pctTurmasQueda = percentual(quedaDesempenho.length, totalTurmas);
  const pctRiscoReprovacao = percentual(alunosRiscoReprovacao, totalAlunos);
  const academicoStatus = falhouAcademico
    ? 'indisponivel' : classificar(Math.max(pctTurmasQueda, pctRiscoReprovacao), pctTurmasQueda + pctRiscoReprovacao, config.limite_critico_academico, config.limite_atencao_academico);

  // ── Financeiro: mensalidades atrasadas relativas ao total de alunos ─────
  const pctAtraso = percentual(brutos.atrasoRow?.qtd || 0, totalAlunos);
  const financeiroStatus = algumaFalha('mensalidades_atrasadas') ? 'indisponivel' : classificar(pctAtraso, pctAtraso, config.limite_critico_financeiro, config.limite_atencao_financeiro);

  // ── Documentação: alunos + professores + funcionários a vencer ──────────
  const totalDocsVencendo = (brutos.documentosVencendoRow?.qtd || 0) + (brutos.documentosProfessorVencendoRow?.qtd || 0) + (brutos.documentosFuncionarioVencendoRow?.qtd || 0);
  const pctDocsVencendo = percentual(totalDocsVencendo, totalAlunos + totalProfessores);
  const documentacaoStatus = algumaFalha('documentos_vencendo', 'documentos_professor_vencendo', 'documentos_funcionario_vencendo', 'documentacao_incompleta')
    ? 'indisponivel' : classificar(pctDocsVencendo, pctDocsVencendo + pctDocIncompleta, config.limite_critico_documentacao, config.limite_atencao_documentacao);

  // ── Turmas: superlotação + salas + sem professor ────────────────────────
  const problemasTurmas = (brutos.turmasLotadas?.length || 0) + (brutos.salasLotadas?.length || 0) + (brutos.turmasSemProfRow?.qtd || 0);
  const pctProblemasTurmas = percentual(problemasTurmas, totalTurmas);
  const turmasStatus = algumaFalha('turmas_superlotadas', 'salas_superlotadas', 'turmas_sem_professor')
    ? 'indisponivel' : classificar(pctProblemasTurmas, pctProblemasTurmas, config.limite_critico_turmas, config.limite_atencao_turmas);

  // ── Ano letivo: janela de renovação + proximidade do fim do ano ─────────
  // v113 — getAnoLetivoAtivo/verificarJanelaRenovacaoAberta já devolvem
  // valores neutros quando não há configuração (ano civil virtual, janela
  // sempre aberta); uma exceção aqui é sempre um erro real de consulta, não
  // "ainda não configurado" — por isso agora vira 'indisponivel', não 'ok'.
  let anoLetivoStatus = 'ok';
  try {
    const anoAtivo = await getAnoLetivoAtivo(schoolId);
    const janela = await verificarJanelaRenovacaoAberta(schoolId);
    const diasParaFimAno = anoAtivo?.data_fim
      ? Math.ceil((new Date(anoAtivo.data_fim) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const renovacoesPendentesQtd = brutos.renovacoesPendentesRow?.qtd || 0;
    if (algumaFalha('renovacoes_pendentes')) {
      anoLetivoStatus = 'indisponivel';
    } else if ((diasParaFimAno !== null && diasParaFimAno < 0) || janela.ja_fechou) {
      anoLetivoStatus = 'critico';
    } else if ((diasParaFimAno !== null && diasParaFimAno <= config.dias_aviso_fim_ano_letivo) || renovacoesPendentesQtd > 0) {
      anoLetivoStatus = 'atencao';
    }
  } catch (e) {
    console.error("[v0] Falha ao calcular status do ano letivo para o Radar da Escola:", e.message);
    anoLetivoStatus = 'indisponivel';
  }

  return [
    { area: 'Alunos', icone: '👨‍🎓', status: alunosStatus },
    { area: 'Professores', icone: '👨‍🏫', status: professoresStatus },
    { area: 'Académico', icone: '📚', status: academicoStatus },
    { area: 'Financeiro', icone: '💰', status: financeiroStatus },
    { area: 'Documentação', icone: '📄', status: documentacaoStatus },
    { area: 'Turmas', icone: '🏫', status: turmasStatus },
    { area: 'Ano Letivo', icone: '📅', status: anoLetivoStatus },
  ];
};

/**
 * Indicadores "tudo bem" — os mesmos números vistos pelo lado positivo, para
 * o administrador também ver o que já está a funcionar, não só problemas.
 *
 * v118 — 'presencas_registadas' foi separado em dois indicadores distintos,
 * porque eram (e continuam a ser, noutros pontos do sistema — ver
 * dashboardController.js "frequencia_baixa" e calcularKpisEscola
 * "frequencia_media_escola") duas perguntas diferentes:
 *  - Cobertura do lançamento: alunos com pelo menos 1 registo de presença /
 *    alunos esperados. Responde "os professores estão a lançar presença?".
 *  - Taxa de presença: presenças / registos lançados (aproximação de
 *    "presenças / aulas esperadas" — o sistema ainda não cruza com o
 *    horário para saber quantas aulas cada aluno deveria ter tido).
 *    Responde "os alunos estão a vir às aulas?".
 * Um número baixo na primeira não diz nada sobre a segunda (pode ser 100%
 * de presença nos poucos registos lançados) — misturá-las levava a ler
 * "50% de cobertura" como "50% de frequência", que são afirmações
 * diferentes sobre a escola.
 */
const calcularIndicadoresPositivos = async (schoolId) => {
  // v113 — antes, uma falha aqui virava `{ total: 0 }`, e como "sem dados"
  // era tratado igual a "tudo em dia", isso produzia 100% FALSO nas
  // mensalidades e na documentação — o painel ficava mais verde quanto
  // pior fosse a falha. Agora cada consulta que falhar marca `falhou: true`
  // e o indicador correspondente é devolvido como indisponível, nunca como
  // um percentual inventado.
  let falhouMensalidades = false;
  let falhouCobertura = false;
  let falhouTaxaPresenca = false;
  let falhouDocs = false;
  const [[mensalidadesRow], [coberturaRow], [taxaPresencaRow], [docsRow]] = await Promise.all([
    queryAsync(
      `SELECT
        SUM(CASE WHEN status = 'pago' THEN 1 ELSE 0 END) as pagas, COUNT(*) as total
       FROM student_payments WHERE school_id = ? AND MONTH(data_vencimento) = MONTH(CURDATE()) AND YEAR(data_vencimento) = YEAR(CURDATE())`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular indicador 'taxa_pagamento_mes':", e.message); falhouMensalidades = true; return [{ pagas: 0, total: 0 }]; }),
    queryAsync(
      `SELECT COUNT(DISTINCT student_id) as com_registo, (SELECT COUNT(*) FROM students WHERE school_id = ? AND ativo = 1) as total_alunos
       FROM presencas WHERE school_id = ? AND data >= CURDATE() - INTERVAL 30 DAY`,
      [schoolId, schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular indicador 'cobertura_lancamento_presencas':", e.message); falhouCobertura = true; return [{ com_registo: 0, total_alunos: 0 }]; }),
    queryAsync(
      `SELECT AVG(pct) as taxa_presenca FROM (
        SELECT student_id, SUM(CASE WHEN status IN ('presente','atraso') THEN 1 ELSE 0 END) / COUNT(*) * 100 as pct
        FROM presencas WHERE school_id = ? AND data >= CURDATE() - INTERVAL 30 DAY
        GROUP BY student_id
      ) x`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular indicador 'taxa_presenca':", e.message); falhouTaxaPresenca = true; return [{ taxa_presenca: null }]; }),
    queryAsync(
      `SELECT
        SUM(CASE WHEN documento IS NOT NULL AND TRIM(documento) != '' THEN 1 ELSE 0 END) as completos, COUNT(*) as total
       FROM students WHERE school_id = ? AND ativo = 1`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular indicador 'documentacao_completa':", e.message); falhouDocs = true; return [{ completos: 0, total: 0 }]; }),
  ]);

  const pctMensalidades = mensalidadesRow?.total > 0 ? arredondar((mensalidadesRow.pagas / mensalidadesRow.total) * 100, 0) : 100;
  const pctCobertura = coberturaRow?.total_alunos > 0 ? arredondar((coberturaRow.com_registo / coberturaRow.total_alunos) * 100, 0) : 0;
  const pctTaxaPresenca = taxaPresencaRow?.taxa_presenca !== null && taxaPresencaRow?.taxa_presenca !== undefined ? arredondar(taxaPresencaRow.taxa_presenca, 0) : null;
  const pctDocumentacao = docsRow?.total > 0 ? arredondar((docsRow.completos / docsRow.total) * 100, 0) : 100;

  return [
    {
      chave: 'taxa_pagamento_mes',
      texto: falhouMensalidades ? 'Não foi possível calcular a taxa de pagamento do mês' : `${pctMensalidades}% das mensalidades deste mês já pagas`,
      percentual: falhouMensalidades ? null : pctMensalidades,
      indisponivel: falhouMensalidades,
    },
    {
      chave: 'cobertura_lancamento_presencas',
      texto: falhouCobertura ? 'Não foi possível calcular a cobertura de lançamento de presenças' : `${pctCobertura}% dos alunos têm presença lançada nos últimos 30 dias (cobertura de lançamento — não é taxa de frequência)`,
      percentual: falhouCobertura ? null : pctCobertura,
      indisponivel: falhouCobertura,
    },
    {
      chave: 'taxa_presenca',
      texto: (falhouTaxaPresenca || pctTaxaPresenca === null) ? 'Ainda sem presenças lançadas suficientes para calcular a taxa de frequência' : `${pctTaxaPresenca}% de taxa de presença entre os alunos com registo nos últimos 30 dias`,
      percentual: falhouTaxaPresenca ? null : pctTaxaPresenca,
      indisponivel: falhouTaxaPresenca,
    },
    {
      chave: 'documentacao_completa',
      texto: falhouDocs ? 'Não foi possível calcular a documentação completa' : `${pctDocumentacao}% das documentações completas`,
      percentual: falhouDocs ? null : pctDocumentacao,
      indisponivel: falhouDocs,
    },
  ];
};

/**
 * Top 10 alunos que mais precisam de atenção — pontuação composta a partir
 * de sinais já existentes no sistema (frequência, PPF, financeiro,
 * documentação, situação académica).
 *
 * v117 — o componente académico deixou de comparar a média BRUTA das notas
 * (AVG(valor), sem pesos) contra a nota mínima e passou a reaproveitar
 * getSituacoesAcademicasEscola() — a mesma classificação por disciplina
 * (pesos de Testes/Trabalhos/ACP/Exame, nota mínima, avaliação contínua
 * incompleta) usada no boletim do aluno. Isso elimina o caso em que este
 * ranking listava "média abaixo da nota mínima" para um aluno cujo boletim
 * mostrava Aprovado (ou vice-versa).
 */
export const calcularTop10AlunosAtencao = async (schoolId) => {
  const faltasMaxPPF = await getFaltasMaxPPF(schoolId);
  const situacoesEscola = await getSituacoesAcademicasEscola(schoolId);

  const linhas = await queryAsync(
    `
      SELECT
        s.id, s.nome, t.nome as turma_nome,
        COALESCE(freq.percentual, 100) as frequencia_percentual,
        COALESCE(freq.faltas, 0) as faltas,
        COALESCE(fin.total_atrasado, 0) as total_atrasado,
        (s.documento IS NULL OR TRIM(s.documento) = '') as doc_incompleta
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN (
        SELECT student_id,
          SUM(CASE WHEN status IN ('presente','atraso') THEN 1 ELSE 0 END) / COUNT(*) * 100 as percentual,
          SUM(CASE WHEN status = 'falta' THEN 1 ELSE 0 END) as faltas
        FROM presencas WHERE school_id = ?
        GROUP BY student_id
      ) freq ON freq.student_id = s.id
      LEFT JOIN (
        SELECT student_id, SUM(valor_original + COALESCE(multa, 0)) as total_atrasado
        FROM student_payments WHERE school_id = ? AND status = 'atrasado'
        GROUP BY student_id
      ) fin ON fin.student_id = s.id
      WHERE s.school_id = ? AND s.ativo = 1
    `,
    [schoolId, schoolId, schoolId]
  );

  const comPontuacao = linhas.map((aluno) => {
    let pontos = 0;
    const motivos = [];

    if (faltasMaxPPF > 0 && aluno.faltas >= faltasMaxPPF * 0.8) { pontos += 3; motivos.push('risco de exclusão por faltas'); }
    else if (aluno.frequencia_percentual < 75) { pontos += 2; motivos.push('frequência abaixo de 75%'); }

    if (aluno.total_atrasado > 0) { pontos += 2; motivos.push('mensalidade em atraso'); }

    // situação já reflete faltas/PPF ('Excluído') — não somar pontos aqui de
    // novo para não contar o mesmo risco duas vezes; só o lado académico.
    const situacaoAcademica = situacoesEscola[aluno.id]?.situacao || null;
    if (SITUACOES_REPROVACAO.has(situacaoAcademica)) { pontos += 2; motivos.push('reprovado em pelo menos uma disciplina'); }
    else if (situacaoAcademica === 'Vai a Exame') { pontos += 1; motivos.push('vai a exame em pelo menos uma disciplina'); }

    if (aluno.doc_incompleta) { pontos += 1; motivos.push('documentação incompleta'); }

    return { ...aluno, situacao_academica: situacaoAcademica, pontos, motivos };
  });

  return comPontuacao
    .filter((a) => a.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, 10)
    .map((a) => ({
      id: a.id, nome: a.nome, turma_nome: a.turma_nome || '—',
      frequencia_percentual: arredondar(a.frequencia_percentual),
      total_atrasado: arredondar(a.total_atrasado, 2),
      situacao_academica: a.situacao_academica,
      motivos: a.motivos, pontos: a.pontos,
    }));
};

/**
 * GET /schools/:schoolId/insights/painel
 * Endpoint único do Falcon Insights: os 3 blocos (🔴 atenção imediata / 🟡
 * acompanhamento / 🟢 tudo bem), o Radar da Escola e as quedas de
 * desempenho detetadas — tudo o que a tela principal precisa numa só chamada.
 */
export const getPainelInsights = async (req, res) => {
  try {
    const { schoolId } = req.params;
    await Promise.all([ensureTabelasDashboard(), ensurePresencasTableExists(), ensurePaymentColumnsExist()]);

    const sinais = await calcularSinaisEscola(schoolId);
    const quedaDesempenho = await calcularQuedaDesempenho(schoolId);
    const radarConfig = await getRadarConfig(schoolId);
    const [radar, indicadoresPositivos] = await Promise.all([
      calcularRadarEscola(schoolId, sinais, quedaDesempenho, radarConfig),
      calcularIndicadoresPositivos(schoolId),
    ]);

    // Reaproveita os alertas já classificados por severidade em
    // calcularSinaisEscola(): 'critico' → atenção imediata, 'atencao' →
    // requer acompanhamento. Fica tudo consistente com a Central de Alertas.
    const atencaoImediata = sinais.alertas.filter((a) => a.severidade === 'critico');
    const requerAcompanhamento = [
      ...sinais.alertas.filter((a) => a.severidade === 'atencao'),
      ...quedaDesempenho.map((t) => ({
        chave: `queda_desempenho_${t.turma_id}`, qtd: 1, severidade: 'atencao', pagina: 'turmas',
        titulo: `Queda de desempenho — ${t.turma_nome}`,
        causa: t.disciplinas_criticas.length > 0
          ? `Principal ocorrência: ${t.disciplinas_criticas.map((d) => d.disciplina).join(' e ')}.`
          : 'Queda distribuída entre várias disciplinas.',
        impacto: `Média atual: ${t.media_atual} · Média anterior: ${t.media_anterior} · ↓ ${Math.abs(t.variacao_pct)}%`,
        sugestao: 'Verifique frequência dos alunos e avaliações pendentes nesta turma.',
        turma_id: t.turma_id,
      })),
    ];

    res.json({
      success: true,
      radar,
      // v113 — o Radar não é uma verdade institucional universal: os
      // limiares que decidem 🟢/🟡/🔴 são configuráveis por escola (ver
      // Configurações → Radar da Escola). O frontend deve mostrar este aviso
      // junto do Radar, não tratar o score como um veredito fixo do sistema.
      radar_aviso: 'Score calculado segundo os parâmetros configurados pela escola.',
      radar_config: radarConfig,
      atencao_imediata: atencaoImediata,
      requer_acompanhamento: requerAcompanhamento,
      tudo_bem: indicadoresPositivos,
      queda_desempenho: quedaDesempenho,
      // v113 — chaves dos sinais que não puderam ser calculados nesta
      // consulta (ver dashboardController.calcularSinaisEscola). O frontend
      // usa isto para mostrar um aviso explícito em vez de deixar o admin
      // acreditar que a ausência de alertas significa que está tudo bem.
      falhas: sinais.falhas || [],
      gerado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[v0] Erro ao montar o painel Falcon Insights:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar o painel de insights', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/insights/top-alunos-atencao
 * Endpoint dedicado (também usado pelo assistente) para a lista dos 10
 * alunos que mais precisam de acompanhamento agora.
 */
export const getTopAlunosAtencao = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const alunos = await calcularTop10AlunosAtencao(schoolId);
    res.json({ success: true, alunos });
  } catch (err) {
    console.error('[v0] Erro ao calcular top alunos que precisam de atenção:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular alunos que precisam de atenção' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FALCON PERFORMANCE — Painel de Desempenho da Escola (Command Center)
// ─────────────────────────────────────────────────────────────────────────────
// Complementa o Falcon Insights (que responde "o que precisa da minha
// atenção") com a visão inversa: "como está a escola como um todo, em
// números". Reaproveita deliberadamente o mesmo motor de situação escolar já
// usado no perfil 360 do aluno (avaliarSituacaoEscolar) para a contagem de
// risco, para os dois ecrãs nunca mostrarem números diferentes para a mesma
// realidade.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ranking de turmas por média geral das notas lançadas — só entram turmas
 * com pelo menos 3 notas lançadas, para não deixar uma turma "subir" ao topo
 * ou "cair" ao fundo por causa de 1 ou 2 lançamentos isolados.
 */
export const calcularRankingTurmas = async (schoolId) => {
  let linhas = [];
  let indisponivel = false;
  try {
    linhas = await queryAsync(
      `
        SELECT t.id as turma_id, t.nome as turma_nome, AVG(g.valor) as media, COUNT(g.id) as total_notas
        FROM turmas t
        INNER JOIN students s ON s.turma_id = t.id AND s.school_id = t.school_id AND s.ativo = 1
        INNER JOIN grades g ON g.student_id = s.id AND g.school_id = t.school_id
        WHERE t.school_id = ? AND t.ativa = 1
        GROUP BY t.id, t.nome
        HAVING total_notas >= 3
      `,
      [schoolId]
    );
  } catch (e) {
    // v113 — "ainda sem notas suficientes lançadas" não dá erro de SQL (a
    // query só devolve 0 linhas); uma exceção aqui é sempre falha real.
    console.error("[v0] Falha ao calcular ranking de turmas:", e.message);
    indisponivel = true;
  }

  const turmas = linhas
    .map((l) => ({ turma_id: l.turma_id, turma_nome: l.turma_nome, media: arredondar(l.media, 2) }))
    .sort((a, b) => b.media - a.media);

  return {
    melhores: turmas.slice(0, 3),
    atencao: [...turmas].sort((a, b) => a.media - b.media).slice(0, 3),
    indisponivel,
  };
};

/**
 * KPIs agregados da escola inteira: média geral, frequência média, %
 * mensalidades pagas este mês e taxa de aprovação projetada (percentagem dos
 * alunos com notas lançadas cuja situação académica atual — calculada pelo
 * mesmo motor do boletim, com pesos de Testes/Trabalhos/ACP/Exame — já é
 * Aprovado ou Dispensado).
 *
 * v117 — `media_geral_escola` continua sendo a média bruta de todas as notas
 * (é uma estatística descritiva, "qual é a nota média lançada na escola",
 * não um veredito de aprovação — não há inconsistência em usar AVG() aqui).
 * `taxa_aprovacao_projetada`, por ser uma contagem de aprovação/reprovação,
 * passou a usar getSituacoesAcademicasEscola() em vez de comparar a média
 * bruta contra a nota mínima — ver CHANGELOG_v117.md.
 */
export const calcularKpisEscola = async (schoolId, config) => {
  // v113 — antes, "sem dados ainda" (escola sem notas lançadas) e "falha ao
  // consultar" (erro de conexão) produziam exatamente o mesmo `null`, e o
  // frontend mostra os dois como "—" sem diferença nenhuma. Isso é o mesmo
  // problema do Radar da Escola, só que aqui numa tela que já está mesmo
  // ligada ao admin. `indisponiveis` lista as chaves que falharam de
  // verdade, para o painel poder marcar ⚪ em vez de um "—" ambíguo.
  const indisponiveis = [];
  const [[mediaRow], [freqRow], [mensalRow], situacoesEscolaResult, [totaisRow]] = await Promise.all([
    queryAsync(
      `SELECT AVG(media) as media_geral FROM (
        SELECT g.student_id, AVG(g.valor) as media FROM grades g
        INNER JOIN students s ON s.id = g.student_id
        WHERE g.school_id = ? AND s.ativo = 1 GROUP BY g.student_id
      ) x`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular KPI 'media_geral_escola':", e.message); indisponiveis.push('media_geral_escola'); return [{ media_geral: null }]; }),
    queryAsync(
      `SELECT AVG(pct) as frequencia_media FROM (
        SELECT student_id, SUM(CASE WHEN status IN ('presente','atraso') THEN 1 ELSE 0 END) / COUNT(*) * 100 as pct
        FROM presencas WHERE school_id = ? GROUP BY student_id
      ) x`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular KPI 'frequencia_media_escola':", e.message); indisponiveis.push('frequencia_media_escola'); return [{ frequencia_media: null }]; }),
    queryAsync(
      `SELECT SUM(CASE WHEN status = 'pago' THEN 1 ELSE 0 END) as pagas, COUNT(*) as total
       FROM student_payments WHERE school_id = ? AND MONTH(data_vencimento) = MONTH(CURDATE()) AND YEAR(data_vencimento) = YEAR(CURDATE())`,
      [schoolId]
    ).catch((e) => { console.error("[v0] Falha ao calcular KPI 'pct_mensalidades_pagas':", e.message); indisponiveis.push('pct_mensalidades_pagas'); return [{ pagas: 0, total: 0 }]; }),
    getSituacoesAcademicasEscola(schoolId).catch((e) => { console.error("[v0] Falha ao calcular KPI 'taxa_aprovacao_projetada':", e.message); indisponiveis.push('taxa_aprovacao_projetada'); return null; }),
    queryAsync(`SELECT COUNT(*) as total_alunos FROM students WHERE school_id = ? AND ativo = 1`, [schoolId]),
  ]);

  let taxaAprovacaoProjetada = null;
  if (situacoesEscolaResult) {
    const situacoesAlunos = Object.values(situacoesEscolaResult);
    const aprovados = situacoesAlunos.filter((s) => SITUACOES_APROVACAO.has(s.situacao)).length;
    taxaAprovacaoProjetada = situacoesAlunos.length > 0 ? arredondar((aprovados / situacoesAlunos.length) * 100, 0) : null;
  }

  return {
    total_alunos: totaisRow?.total_alunos || 0,
    media_geral_escola: mediaRow?.media_geral !== null && mediaRow?.media_geral !== undefined ? arredondar(mediaRow.media_geral, 2) : null,
    frequencia_media_escola: freqRow?.frequencia_media !== null && freqRow?.frequencia_media !== undefined ? arredondar(freqRow.frequencia_media, 1) : null,
    pct_mensalidades_pagas: mensalRow?.total > 0 ? arredondar((mensalRow.pagas / mensalRow.total) * 100, 0) : null,
    taxa_aprovacao_projetada: taxaAprovacaoProjetada,
    // v113 — chaves de KPIs acima que falharam de verdade (não "sem dados
    // ainda"). Vazio na maioria das vezes.
    indisponiveis,
  };
};

/**
 * GET /schools/:schoolId/insights/desempenho-escola
 * Painel único da escola inteira: KPIs (académico, frequência, financeiro,
 * aprovação projetada), contagem de risco por aluno (reaproveitando o motor
 * de situação escolar) e ranking de turmas — o "School Performance Command
 * Center".
 */
export const getDesempenhoEscola = async (req, res) => {
  try {
    const { schoolId } = req.params;
    await Promise.all([ensurePresencasTableExists(), ensurePaymentColumnsExist()]);
    const config = await getConfigAvaliacao(schoolId);

    const [kpis, { melhores, atencao: turmasAtencao, indisponivel: rankingIndisponivel }, alunosAtencao] = await Promise.all([
      calcularKpisEscola(schoolId, config),
      calcularRankingTurmas(schoolId),
      calcularTop10AlunosAtencao(schoolId),
    ]);

    const risco = {
      alto: alunosAtencao.filter((a) => a.pontos >= 5).length,
      atencao: alunosAtencao.filter((a) => a.pontos > 0 && a.pontos < 5).length,
    };
    risco.estaveis = Math.max(0, kpis.total_alunos - risco.alto - risco.atencao);

    res.json({
      success: true,
      kpis,
      risco,
      turmas_melhor_desempenho: melhores,
      turmas_atencao: turmasAtencao,
      alunos_atencao: alunosAtencao.slice(0, 8),
      // v113 — chaves de KPIs que falharam de verdade (distinto de "sem
      // dados ainda") e se o ranking de turmas não pôde ser calculado.
      kpis_indisponiveis: kpis.indisponiveis || [],
      ranking_indisponivel: rankingIndisponivel || false,
      gerado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[v0] Erro ao montar o painel de desempenho da escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar o painel de desempenho da escola', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ASSISTENTE DO ADMINISTRADOR — perguntas em linguagem natural
// ─────────────────────────────────────────────────────────────────────────────
// Em vez de depender de uma API de IA externa (custo, latência, e uma chave
// que a escola teria de configurar), isto é um motor de intenções: reconhece
// os padrões das perguntas mais úteis para um administrador e responde com
// dados REAIS calculados na hora — nunca texto inventado. Extensível: para
// suportar uma pergunta nova, basta adicionar mais um bloco a INTENCOES.
// ═══════════════════════════════════════════════════════════════════════════════

const INTENCOES = [
  {
    id: 'top_alunos_atencao',
    testar: (p) => /alunos?.*(mais )?precis|top.*10.*alun|10 alun.*atenc/.test(p),
    responder: async (schoolId) => {
      const alunos = await calcularTop10AlunosAtencao(schoolId);
      if (alunos.length === 0) return { resposta: 'Nenhum aluno apresenta sinais de atenção neste momento — tudo em ordem.', dados: [] };
      const lista = alunos.map((a, i) => `${i + 1}. ${a.nome} (${a.turma_nome}) — ${a.motivos.join(', ')}`).join('\n');
      return { resposta: `Com base em frequência, notas, situação financeira e documentação, estes são os alunos que mais precisam de acompanhamento:\n\n${lista}`, dados: alunos };
    },
  },
  {
    id: 'turma_pior_desempenho',
    testar: (p) => /turma.*pior|pior.*turma|turma.*desempenho/.test(p),
    responder: async (schoolId) => {
      const quedas = await calcularQuedaDesempenho(schoolId);
      if (quedas.length === 0) return { resposta: 'Nenhuma turma apresenta queda de desempenho relevante nos últimos 90 dias.', dados: [] };
      const pior = quedas[0];
      return {
        resposta: `A turma com maior queda de desempenho é ${pior.turma_nome}: média foi de ${pior.media_anterior} para ${pior.media_atual} (${pior.variacao_pct}%).${pior.disciplinas_criticas.length > 0 ? ` Principal ocorrência: ${pior.disciplinas_criticas.map((d) => d.disciplina).join(' e ')}.` : ''}`,
        dados: quedas,
      };
    },
  },
  {
    id: 'receita_mes',
    testar: (p) => /quanto.*(arrecad|receb|entrou)|receita.*mes|faturamento/.test(p),
    responder: async (schoolId) => {
      const [linha] = await queryAsync(
        `SELECT COALESCE(SUM(valor_pago), 0) as total, COUNT(*) as qtd FROM student_payments
         WHERE school_id = ? AND status = 'pago' AND MONTH(data_pagamento) = MONTH(CURDATE()) AND YEAR(data_pagamento) = YEAR(CURDATE())`,
        [schoolId]
      );
      return { resposta: `Este mês a escola já arrecadou ${arredondar(linha.total, 2)} MZN, através de ${linha.qtd} pagamento(s) confirmado(s).`, dados: linha };
    },
  },
  {
    id: 'mensalidades_atraso',
    testar: (p) => /mensalidad.*atras|atras.*mensalidad|quem.*deve|alunos.*deve/.test(p),
    responder: async (schoolId) => {
      const linhas = await queryAsync(
        `SELECT s.nome, sp.valor_original + COALESCE(sp.multa,0) as valor, sp.data_vencimento
         FROM student_payments sp INNER JOIN students s ON s.id = sp.student_id
         WHERE sp.school_id = ? AND sp.status = 'atrasado' ORDER BY sp.data_vencimento ASC LIMIT 15`,
        [schoolId]
      );
      if (linhas.length === 0) return { resposta: 'Nenhuma mensalidade em atraso neste momento.', dados: [] };
      const lista = linhas.map((l) => `${l.nome} — ${arredondar(l.valor, 2)} MZN (venceu em ${new Date(l.data_vencimento).toLocaleDateString('pt-PT')})`).join('\n');
      return { resposta: `Há ${linhas.length} mensalidade(s) em atraso:\n\n${lista}`, dados: linhas };
    },
  },
  {
    id: 'documentos_vencidos',
    testar: (p) => /document.*venc|venc.*document/.test(p),
    responder: async (schoolId) => {
      // v113 — sem .catch() aqui: uma falha real de consulta agora sobe até
      // o catch de perguntarAssistente() e vira "Não foi possível processar
      // a pergunta agora", em vez do assistente afirmar por engano que não
      // há documentos vencidos.
      const [linha] = await queryAsync(
        `SELECT
          (SELECT COUNT(*) FROM student_documentos d LEFT JOIN students s ON s.id = d.student_id WHERE d.school_id = ? AND d.data_validade IS NOT NULL AND DATEDIFF(d.data_validade, CURDATE()) <= 30 AND (s.ativo = 1 OR s.ativo IS NULL)) as alunos,
          (SELECT COUNT(*) FROM teacher_documentos d LEFT JOIN teachers t ON t.id = d.teacher_id WHERE d.school_id = ? AND d.data_validade IS NOT NULL AND DATEDIFF(d.data_validade, CURDATE()) <= 30 AND (t.ativo = 1 OR t.ativo IS NULL)) as professores,
          (SELECT COUNT(*) FROM funcionario_documentos d LEFT JOIN funcionarios f ON f.id = d.funcionario_id WHERE d.school_id = ? AND d.data_validade IS NOT NULL AND DATEDIFF(d.data_validade, CURDATE()) <= 30 AND (f.ativo = 1 OR f.ativo IS NULL)) as funcionarios
        `,
        [schoolId, schoolId, schoolId]
      );
      const total = (linha?.alunos || 0) + (linha?.professores || 0) + (linha?.funcionarios || 0);
      if (total === 0) return { resposta: 'Nenhum documento vencido ou a vencer nos próximos 30 dias.', dados: linha };
      return {
        resposta: `Há ${total} documento(s) vencido(s) ou a vencer nos próximos 30 dias: ${linha.alunos} de aluno(s), ${linha.professores} de professor(es) e ${linha.funcionarios} de funcionário(s).`,
        dados: linha,
      };
    },
  },
  {
    id: 'risco_reprovacao',
    testar: (p) => /risco.*reprov|reprov.*risco|quantos.*reprovar/.test(p),
    responder: async (schoolId) => {
      const qtd = await contarAlunosRiscoReprovacao(schoolId);
      if (qtd === 0) return { resposta: 'Nenhum aluno está, no momento, com a média abaixo da nota mínima de aprovação.', dados: { qtd } };
      return { resposta: `${qtd} aluno(s) estão atualmente com a média abaixo da nota mínima de aprovação.`, dados: { qtd } };
    },
  },
];

const RESPOSTA_PADRAO = 'Não entendi bem a pergunta. Pode perguntar, por exemplo: "quais são os 10 alunos que mais precisam de atenção", "qual turma está com pior desempenho", "quanto a escola arrecadou este mês", "quais mensalidades estão em atraso", "quais documentos estão vencidos" ou "quantos alunos estão em risco de reprovação".';

/**
 * POST /schools/:schoolId/insights/perguntar
 * Body: { pergunta: string }
 */
export const perguntarAssistente = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { pergunta } = req.body || {};
    if (!pergunta || !pergunta.trim()) {
      return res.status(400).json({ success: false, message: 'Escreva uma pergunta.' });
    }

    await Promise.all([ensurePresencasTableExists(), ensurePaymentColumnsExist()]);

    const perguntaNormalizada = normalizar(pergunta);
    const intencao = INTENCOES.find((i) => i.testar(perguntaNormalizada));

    if (!intencao) {
      return res.json({ success: true, resposta: RESPOSTA_PADRAO, dados: null, intencao: null });
    }

    const { resposta, dados } = await intencao.responder(schoolId);
    res.json({ success: true, resposta, dados, intencao: intencao.id });
  } catch (err) {
    console.error('[v0] Erro no assistente do Falcon Insights:', err);
    res.status(500).json({ success: false, message: 'Não foi possível processar a pergunta agora.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULADOR "E SE...?" — POST /schools/:schoolId/insights/simulador
// Body: { tipo: 'frequencia' | 'retencao' | 'notas', parametros: {...} }
// Cenários hipotéticos calculados em memória a partir de dados reais — NUNCA
// escreve nada na base de dados. Lógica completa em services/simuladorService.js.
// ═══════════════════════════════════════════════════════════════════════════════
export const simularCenario = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { tipo, parametros } = req.body || {};
    if (!tipo) {
      return res.status(400).json({ success: false, message: 'Indique o tipo de cenário: "frequencia", "retencao" ou "notas".' });
    }

    await Promise.all([ensurePresencasTableExists(), ensurePaymentColumnsExist()]);

    const resultado = await executarSimulacao(schoolId, tipo, parametros || {});
    res.json({ success: true, ...resultado });
  } catch (err) {
    console.error('[v0] Erro no Simulador "E se...?":', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Não foi possível calcular a simulação agora.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMAÇÃO ADMINISTRATIVA — regras "quando X acontecer, fazer Y"
// GET/POST/PUT/DELETE /schools/:schoolId/insights/automacao/regras[/:regraId]
// POST /schools/:schoolId/insights/automacao/executar — executa agora (manual)
// Lógica completa em services/automationService.js.
// ═══════════════════════════════════════════════════════════════════════════════

export const getTiposAutomacao = (req, res) => {
  res.json({ success: true, tipos: listarTiposDisponiveis() });
};

export const getRegrasAutomacao = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const regras = await listarRegras(schoolId);
    res.json({ success: true, regras });
  } catch (err) {
    console.error('[v0] Erro ao listar regras de automação:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar regras de automação', error: err.message });
  }
};

export const criarRegraAutomacao = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { tipo, parametros, nome } = req.body || {};
    if (!tipo) return res.status(400).json({ success: false, message: 'Indique o tipo de regra.' });
    const regra = await criarRegra(schoolId, { tipo, parametros, nome });
    res.status(201).json({ success: true, regra });
  } catch (err) {
    console.error('[v0] Erro ao criar regra de automação:', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Erro ao criar regra de automação' });
  }
};

export const atualizarRegraAutomacao = async (req, res) => {
  try {
    const { schoolId, regraId } = req.params;
    const { parametros, nome, ativo } = req.body || {};
    const regra = await atualizarRegra(schoolId, regraId, { parametros, nome, ativo });
    res.json({ success: true, regra });
  } catch (err) {
    console.error('[v0] Erro ao atualizar regra de automação:', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Erro ao atualizar regra de automação' });
  }
};

export const removerRegraAutomacao = async (req, res) => {
  try {
    const { schoolId, regraId } = req.params;
    await removerRegra(schoolId, regraId);
    res.json({ success: true, message: 'Regra de automação removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover regra de automação:', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Erro ao remover regra de automação' });
  }
};

export const executarRegrasAutomacaoAgora = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const resultados = await executarTodasRegras(schoolId);
    res.json({ success: true, resultados });
  } catch (err) {
    console.error('[v0] Erro ao executar regras de automação:', err);
    res.status(500).json({ success: false, message: 'Erro ao executar regras de automação', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO EXECUTIVO — "o Falcon escreve o relatório sozinho"
// GET  /schools/:schoolId/insights/relatorio-executivo?periodo=... — JSON, para o ecrã
// GET  /schools/:schoolId/insights/relatorio-executivo/pdf?periodo=... — download em PDF
// Lógica completa em services/relatorioExecutivoService.js.
// ═══════════════════════════════════════════════════════════════════════════════

export const getRelatorioExecutivo = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { periodo } = req.query;
    await Promise.all([ensurePresencasTableExists(), ensurePaymentColumnsExist()]);
    const relatorio = await gerarRelatorioExecutivo(schoolId, { nomePeriodo: periodo });
    res.json({ success: true, ...relatorio });
  } catch (err) {
    console.error('[v0] Erro ao gerar o Relatório Executivo:', err);
    res.status(500).json({ success: false, message: 'Não foi possível gerar o Relatório Executivo agora.', error: err.message });
  }
};

export const baixarRelatorioExecutivoPDF = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { periodo } = req.query;
    await Promise.all([ensurePresencasTableExists(), ensurePaymentColumnsExist()]);
    await gerarRelatorioExecutivoPDF(res, schoolId, { nomePeriodo: periodo });
  } catch (err) {
    console.error('[v0] Erro ao gerar o PDF do Relatório Executivo:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Não foi possível gerar o PDF do Relatório Executivo agora.', error: err.message });
    } else {
      res.end();
    }
  }
};

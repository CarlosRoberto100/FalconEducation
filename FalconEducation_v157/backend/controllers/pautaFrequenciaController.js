import db from '../config/db.js';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  getConfigAvaliacao,
  calcularMediaDisciplina,
  avaliacaoContinuaCompleta,
  calcularSituacaoDisciplina,
  getFaltasMaxPPF,
  ensureGradeColumnsExist,
} from './gradeController.js';
import { calcularAprovacaoEnsinoGeral2022 } from '../services/mozaEvaluationRules.js';
import { ensureClassDisciplinaSecaoColumnExists } from './secaoController.js';
import { getAnoLetivoAtivo } from './academicYearController.js';
import { registrarAuditoria } from '../services/auditService.js';
import {
  ensureConfiguracaoAcademicaClasseTableExists,
  getConfiguracaoAcademicaEfetiva,
} from '../services/configuracaoAcademicaService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PAUTA DE FREQUÊNCIA E RESULTADOS — v137
 * ─────────────────────────────────────────────────────────────────────────────
 * Este ficheiro NÃO substitui a "Tabela de Avaliação da Turma" já existente em
 * gradeController.js (montarDadosPautaTurma / getBoletimTurma / gerarPautaOficialPDF)
 * — essa continua a servir o boletim rápido "aluno × disciplina → 1 média" já
 * usado no modal "Tabela de Avaliação". Esta Pauta é um documento mais completo,
 * pensado para corresponder ao modelo oficial usado nas escolas moçambicanas:
 *
 *   N.º | Nome completo | Género | [DISCIPLINA: 1.º Trim | 2.º Trim | 3.º Trim | Média] × N | Média Geral | Resultado
 *
 * com numeração reiniciada por turma, ordenação alfabética, resultado
 * terminológico (Transita/Não Transita OU Aprovado/Reprovado, nunca os dois
 * misturados na mesma turma) e estado "Pendente" sempre que os dados ainda não
 * permitem apurar um veredito — nunca um "Reprovado" inventado a partir de
 * notas incompletas.
 *
 * Reaproveita deliberadamente as MESMAS funções puras do motor de notas
 * (calcularMediaDisciplina, avaliacaoContinuaCompleta, calcularSituacaoDisciplina)
 * usadas pelo boletim do aluno e pela pauta oficial — para esta Pauta nunca
 * poder divergir do boletim que o encarregado de educação vê no Portal do Aluno.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const PERIODOS = ['1º Período', '2º Período', '3º Período'];
const LABEL_TRIMESTRE = { '1º Período': '1.º Trimestre', '2º Período': '2.º Trimestre', '3º Período': '3.º Trimestre' };

/**
 * CONFIGURAÇÃO ACADÉMICA POR CLASSE (possui_exame) — extraída para
 * services/configuracaoAcademicaService.js na v147 (reaproveitada também
 * por gradeController.js/professorPortalController.js no lançamento de
 * notas, para "Exame" só aparecer como tipo de avaliação em classes que
 * a escola marcou como tendo exame).
 */

/**
 * GET /schools/:schoolId/configuracao-academica
 * Lista, para cada classe da escola, a configuração académica efetiva —
 * usada pela aba de Configurações para o administrador rever/confirmar
 * `possui_exame` de cada classe antes de emitir pautas oficiais.
 */
export const listarConfiguracaoAcademica = async (req, res) => {
  try {
    const { schoolId } = req.params;
    await ensureConfiguracaoAcademicaClasseTableExists();
    const configEscola = await getConfigAvaliacao(schoolId);

    const classes = await queryAsync(
      `SELECT id, nome FROM classes WHERE school_id = ? ORDER BY
         CAST(REGEXP_REPLACE(nome, '[^0-9]', '') AS UNSIGNED) ASC, nome ASC`,
      [schoolId]
    );

    const dados = await Promise.all(
      classes.map((c) => getConfiguracaoAcademicaEfetiva(schoolId, c.id, c.nome, configEscola))
    );

    res.json({ success: true, data: dados });
  } catch (err) {
    console.error('[v0] Erro ao listar configuração académica por classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar configuração académica', error: err.message });
  }
};

/**
 * PUT /schools/:schoolId/classes/:classeId/configuracao-academica
 * Body: { possui_exame: boolean|null, nota_minima_aprovacao?: number|null, observacoes?: string }
 * `possui_exame: null` remove a configuração manual e volta a usar a
 * sugestão automática (não deve ser tratado como "não tem exame").
 */
export const salvarConfiguracaoAcademica = async (req, res) => {
  try {
    const { schoolId, classeId } = req.params;
    const { possui_exame, nota_minima_aprovacao, observacoes } = req.body;
    await ensureConfiguracaoAcademicaClasseTableExists();

    const classeRows = await queryAsync(`SELECT id, nome FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);
    if (classeRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe não encontrada' });
    }

    let notaMinimaFinal = null;
    if (nota_minima_aprovacao !== undefined && nota_minima_aprovacao !== null && nota_minima_aprovacao !== '') {
      const n = parseFloat(nota_minima_aprovacao);
      if (!Number.isFinite(n) || n < 0 || n > 20) {
        return res.status(400).json({ success: false, message: 'A nota mínima de aprovação deve estar entre 0 e 20' });
      }
      notaMinimaFinal = n;
    }

    const possuiExameFinal = possui_exame === null || possui_exame === undefined ? null : !!possui_exame;
    const configuradoManualmente = possuiExameFinal !== null;

    const [antiga] = await queryAsync(`SELECT * FROM configuracao_academica_classe WHERE school_id = ? AND classe_id = ?`, [schoolId, classeId]);

    await queryAsync(
      `
        INSERT INTO configuracao_academica_classe
          (school_id, classe_id, possui_exame, nota_minima_aprovacao, observacoes, configurado_manualmente, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          possui_exame = VALUES(possui_exame),
          nota_minima_aprovacao = VALUES(nota_minima_aprovacao),
          observacoes = VALUES(observacoes),
          configurado_manualmente = VALUES(configurado_manualmente),
          updated_at = NOW()
      `,
      [schoolId, classeId, possuiExameFinal, notaMinimaFinal, observacoes || null, configuradoManualmente]
    );

    await registrarAuditoria(req, {
      acao: 'configuracao_academica_classe_alterada',
      entidadeTipo: 'configuracao_academica_classe',
      entidadeId: classeId,
      dadosAntigos: antiga || null,
      dadosNovos: { possui_exame: possuiExameFinal, nota_minima_aprovacao: notaMinimaFinal, observacoes: observacoes || null },
    });

    const atualizada = await getConfiguracaoAcademicaEfetiva(schoolId, classeId, classeRows[0].nome);
    res.json({ success: true, message: 'Configuração académica da classe salva com sucesso', data: atualizada });
  } catch (err) {
    console.error('[v0] Erro ao salvar configuração académica da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração académica da classe', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * RESULTADO DO ALUNO
 * ─────────────────────────────────────────────────────────────────────
 * Estados possíveis (ver pedido do utilizador, secção 11):
 *   TRANSITA / NAO_TRANSITA  → classes sem exame (possui_exame = false)
 *   APROVADO / REPROVADO     → classes com exame (possui_exame = true)
 *   PENDENTE                 → ainda faltam dados para apurar o resultado
 *   EXCLUIDO                 → excluído por excesso de faltas (PPF) — este
 *                              5.º estado NÃO estava no pedido original, mas
 *                              já existe como conceito central noutras partes
 *                              do sistema (Situação Escolar, Renovação de
 *                              Matrícula — ver academicStatusService.js) e
 *                              esconder essa distinção aqui seria pior do que
 *                              acrescentá-la: um aluno excluído por faltas
 *                              não é o mesmo que "Reprovado por notas", e a
 *                              escola precisa de saber a diferença ao emitir
 *                              a pauta oficial.
 *
 * v139 — `opcoes.usarTolerancia` (vem de config.usar_tolerancia_transicao_
 * esg1, ligado pela escola em Configurações) aplica a tolerância do Artigo
 * 61.º, n.º 2 / 77.º, n.º 2 do Diploma Ministerial n.º 59/2015: no 1.º
 * Ciclo do ESG (8.ª-10.ª classe), até duas disciplinas entre 8-9 valores
 * não impedem a transição se a média global for ≥10 e nenhuma disciplina
 * ficar abaixo de 8 (ver aplicarToleranciaTransicaoESG1 em
 * gradeController.js — mesma função usada no Boletim do aluno, para os
 * dois documentos nunca discordarem um do outro).
 * ═══════════════════════════════════════════════════════════════════════
 */
export const calcularResultadoAluno = (disciplinasInfo, excluidoPorFaltas, possuiExame, opcoes = {}) => {
  if (excluidoPorFaltas) {
    return { estado: 'EXCLUIDO', motivos: ['Excluído por excesso de faltas (limite de PPF ultrapassado)'] };
  }
  if (disciplinasInfo.length === 0) {
    return { estado: 'PENDENTE', motivos: ['Esta classe ainda não tem disciplinas configuradas no currículo'] };
  }

  const motivos = [];
  let temReprovado = false;
  let temPendente = false;
  const disciplinasReprovadas = [];

  disciplinasInfo.forEach((d) => {
    if (d.situacao === 'Sem notas') {
      temPendente = true;
      motivos.push(`${d.nome}: sem notas lançadas`);
    } else if (d.situacao === 'Incompleto') {
      temPendente = true;
      motivos.push(`${d.nome}: avaliação contínua ainda incompleta`);
    } else if (d.situacao === 'Vai a Exame') {
      temPendente = true;
      motivos.push(`${d.nome}: aguarda nota de Exame`);
    } else if (d.situacao === 'Reprovado') {
      temReprovado = true;
      disciplinasReprovadas.push(d);
    }
  });

  if (temPendente) return { estado: 'PENDENTE', motivos };

  const resultado2022 = calcularAprovacaoEnsinoGeral2022({
    disciplinas: disciplinasInfo.map((d) => ({ nome: d.nome, media: d.media_geral, situacao: d.situacao })),
    mediaGlobal: opcoes.mediaGeral,
    possuiExame,
    excluidoPorFaltas,
  });
  return {
    // v153 — "Não Transita" (classes sem exame) tinha estado próprio no mapa
    // de rótulos (NAO_TRANSITA) mas nunca era atingido: caía no `else` final
    // e virava 'REPROVADO', pelo que a coluna "Resultado" da Pauta de
    // Frequência mostrava "Reprovado" a um aluno de classe sem exame, ao lado
    // de colegas com "Transita". Agora cada situação mapeia para o seu estado.
    estado: resultado2022.situacao === 'Aprovado' ? 'APROVADO'
      : resultado2022.situacao === 'Transita' ? 'TRANSITA'
        : resultado2022.situacao === 'Não Transita' ? 'NAO_TRANSITA'
          : resultado2022.situacao === 'Vai a Exame' ? 'PENDENTE'
            : resultado2022.situacao === 'Incompleto' ? 'PENDENTE' : 'REPROVADO',
    motivos: resultado2022.motivo ? [resultado2022.motivo] : [],
  };
};

// Rótulo em português de Moçambique exibido na coluna "Resultado"
export const rotuloResultado = (estado) => ({
  TRANSITA: 'Transita',
  NAO_TRANSITA: 'Não Transita',
  APROVADO: 'Aprovado',
  REPROVADO: 'Reprovado',
  PENDENTE: 'Pendente',
  EXCLUIDO: 'Excluído',
}[estado] || estado);

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MONTAGEM DA PAUTA DE UMA TURMA
 * ═══════════════════════════════════════════════════════════════════════
 */
export const montarPautaFrequenciaTurma = async (schoolId, turmaId) => {
  await ensureGradeColumnsExist();
  await ensureClassDisciplinaSecaoColumnExists();
  await ensureConfiguracaoAcademicaClasseTableExists();

  const turmaRows = await queryAsync(
    `
      SELECT
        t.id, t.nome as turma_nome, t.class_id, t.secao_id, t.academic_year_id,
        c.nome as classe_nome,
        sec.nome as secao_nome,
        tn.nome as turno_nome,
        te.nome as professor_titular_nome
      FROM turmas t
      LEFT JOIN classes c ON c.id = t.class_id
      LEFT JOIN secoes sec ON sec.id = t.secao_id
      LEFT JOIN turnos tn ON tn.id = t.turno_id
      LEFT JOIN teachers te ON te.id = t.professor_responsavel_id
      WHERE t.id = ? AND t.school_id = ?
      LIMIT 1
    `,
    [turmaId, schoolId]
  );
  if (turmaRows.length === 0) return { erro: 'Turma não encontrada' };
  const turma = turmaRows[0];

  const escolaRows = await queryAsync(`SELECT name, address, nuit, provincia FROM schools WHERE id = ?`, [schoolId]);
  const escola = escolaRows[0] || {};
  const anoLetivo = await getAnoLetivoAtivo(schoolId);

  const config = await getConfigAvaliacao(schoolId);
  const faltasMaxPPF = await getFaltasMaxPPF(schoolId);
  const configAcademica = await getConfiguracaoAcademicaEfetiva(schoolId, turma.class_id, turma.classe_nome, config);
  // A nota mínima de aprovação pode ser sobreposta por classe — usada para
  // decidir Aprovado/Reprovado e Transita/Não Transita nesta pauta, sem
  // alterar a configuração global da escola.
  const configComOverride = { ...config, nota_minima_aprovacao: configAcademica.nota_minima_aprovacao };

  // ── Disciplinas do currículo desta classe/secção (dinâmicas — nunca fixas no código) ──
  const disciplinas = await queryAsync(
    `
      SELECT d.id, d.nome
      FROM class_disciplinas cd
      INNER JOIN disciplinas d ON d.id = cd.disciplina_id
      WHERE cd.school_id = ? AND cd.classe_id = ? AND cd.secao_id IN (0, ?)
      ORDER BY d.nome ASC
    `,
    [schoolId, turma.class_id, turma.secao_id || 0]
  );

  // ── Alunos ativos da turma, já em ordem alfabética — a base da numeração 1..N exclusiva da turma ──
  const alunos = await queryAsync(
    `SELECT id, nome, genero, codigo_aluno FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1 ORDER BY nome ASC`,
    [schoolId, turmaId]
  );

  const notas = alunos.length > 0
    ? await queryAsync(
      `SELECT student_id, disciplina_id, valor, tipo_avaliacao, periodo FROM grades WHERE school_id = ? AND turma_id = ?`,
      [schoolId, turmaId]
    )
    : [];

  // ── Professor responsável por cada disciplina nesta turma (secção de assinaturas) ──
  // Fonte: `horarios` (Timetable) é onde a escola já associa professor↔disciplina↔turma.
  // Uma disciplina pode ter mais do que um professor ao longo do ano (substituição,
  // turnos diferentes) — nesse caso juntam-se os nomes distintos, sem inventar um único
  // "dono" da disciplina. Quando não há horário lançado, a disciplina fica sem professor
  // identificado e a pauta deixa o campo em branco para preenchimento manual.
  let professorNomesPorDisciplina = {};
  if (disciplinas.length > 0) {
    try {
      const horarioRows = await queryAsync(
        `
          SELECT DISTINCT h.disciplina_id, t.nome as teacher_nome
          FROM horarios h
          INNER JOIN teachers t ON t.id = h.teacher_id
          WHERE h.school_id = ? AND h.turma_id = ? AND h.ativo = 1 AND h.teacher_id IS NOT NULL
        `,
        [schoolId, turmaId]
      );
      professorNomesPorDisciplina = horarioRows.reduce((acc, r) => {
        acc[r.disciplina_id] = acc[r.disciplina_id] ? [...acc[r.disciplina_id], r.teacher_nome] : [r.teacher_nome];
        return acc;
      }, {});
    } catch (e) {
      professorNomesPorDisciplina = {}; // tabela de horários pode ainda não existir nesta instalação
    }
  }

  let faltasPorAluno = {};
  if (alunos.length > 0) {
    try {
      const faltasRows = await queryAsync(
        `SELECT student_id, COUNT(*) as total FROM presencas WHERE school_id = ? AND turma_id = ? AND status = 'falta' GROUP BY student_id`,
        [schoolId, turmaId]
      );
      faltasPorAluno = Object.fromEntries(faltasRows.map((r) => [r.student_id, r.total]));
    } catch (e) {
      faltasPorAluno = {}; // tabela de presenças pode ainda não existir nesta instalação
    }
  }

  // Agrupa as notas de uma disciplina, filtrando opcionalmente por período
  const agruparNotas = (linhasDisciplina) => {
    const testes = [];
    const trabalhos = [];
    let acp = null;
    let exame = null;
    linhasDisciplina.forEach((n) => {
      const tipo = String(n.tipo_avaliacao || '');
      const item = { valor: parseFloat(n.valor) };
      if (/^Teste/i.test(tipo)) testes.push(item);
      else if (/^Trabalho/i.test(tipo)) trabalhos.push(item);
      else if (/^ACP/i.test(tipo)) acp = item;
      else if (/^Exame/i.test(tipo)) exame = item;
      else trabalhos.push(item); // tipos legados
    });
    return { testes, trabalhos, acp, exame };
  };

  const linhasAlunos = alunos.map((aluno, indice) => {
    const notasAluno = notas.filter((n) => n.student_id === aluno.id);
    const totalFaltas = faltasPorAluno[aluno.id] || 0;
    const excluidoPorFaltas = totalFaltas >= faltasMaxPPF;

    const disciplinasResultado = disciplinas.map((disc) => {
      const notasDisc = notasAluno.filter((n) => n.disciplina_id === disc.id);

      // Média por trimestre — mesmo critério usado no boletim individual
      // (montarBoletimAluno, gradeController.js): agrupa por período e aplica
      // a MESMA fórmula ponderada da escola às notas lançadas nesse período.
      const porTrimestre = PERIODOS.map((nomePeriodo) => {
        const doTrimestre = agruparNotas(notasDisc.filter((n) => (n.periodo || '1º Período') === nomePeriodo));
        return calcularMediaDisciplina(doTrimestre, configComOverride);
      });

      // Média/situação geral da disciplina no ano — todas as notas lançadas,
      // independentemente do período (mesmo cálculo do boletim anual).
      const todasAsNotas = agruparNotas(notasDisc);
      const mediaGeral = calcularMediaDisciplina(todasAsNotas, configComOverride);
      const completo = avaliacaoContinuaCompleta(todasAsNotas, configComOverride);
      const { situacao } = calcularSituacaoDisciplina(mediaGeral, todasAsNotas.exame != null, configComOverride, completo);

      return {
        disciplina_id: disc.id,
        nome: disc.nome,
        trimestres: porTrimestre, // [média 1º, média 2º, média 3º] — null quando sem notas naquele período
        media_geral: mediaGeral,
        situacao,
      };
    });

    const mediasValidas = disciplinasResultado.map((d) => d.media_geral).filter((m) => m !== null && m !== undefined);
    const mediaGeralAluno = mediasValidas.length > 0
      ? parseFloat((mediasValidas.reduce((s, m) => s + m, 0) / mediasValidas.length).toFixed(2))
      : null;

    const { estado, motivos } = calcularResultadoAluno(
      disciplinasResultado,
      excluidoPorFaltas,
      configAcademica.possui_exame,
      { mediaGeral: mediaGeralAluno, classeNome: turma.classe_nome }
    );

    return {
      numero: indice + 1, // numeração exclusiva desta turma, reiniciada em 1
      student_id: aluno.id,
      nome: aluno.nome,
      genero: aluno.genero || null,
      codigo_aluno: aluno.codigo_aluno || null,
      disciplinas: disciplinasResultado,
      media_geral: mediaGeralAluno,
      total_faltas: totalFaltas,
      excluido_por_faltas: excluidoPorFaltas,
      resultado: estado,
      resultado_label: rotuloResultado(estado),
      motivos_pendencia: motivos,
    };
  });

  // ── Resumo da turma (secção 17 do pedido) ──────────────────────────────
  const contarResultado = (estado) => linhasAlunos.filter((a) => a.resultado === estado).length;
  const mediasGeraisValidas = linhasAlunos.map((a) => a.media_geral).filter((m) => m !== null && m !== undefined);
  const resumo = {
    total_alunos: linhasAlunos.length,
    masculinos: linhasAlunos.filter((a) => a.genero === 'Masculino').length,
    femininos: linhasAlunos.filter((a) => a.genero === 'Feminino').length,
    total_transita: configAcademica.possui_exame ? undefined : contarResultado('TRANSITA'),
    total_nao_transita: configAcademica.possui_exame ? undefined : contarResultado('NAO_TRANSITA'),
    total_aprovado: configAcademica.possui_exame ? contarResultado('APROVADO') : undefined,
    total_reprovado: configAcademica.possui_exame ? contarResultado('REPROVADO') : undefined,
    total_pendente: contarResultado('PENDENTE'),
    total_excluido: contarResultado('EXCLUIDO'),
    media_geral_turma: mediasGeraisValidas.length > 0
      ? parseFloat((mediasGeraisValidas.reduce((s, m) => s + m, 0) / mediasGeraisValidas.length).toFixed(2))
      : null,
  };

  return {
    escola: { nome: escola.name || null, endereco: escola.address || null, nuit: escola.nuit || null, provincia: escola.provincia || null },
    ano_letivo: anoLetivo?.nome || String(new Date().getFullYear()),
    turma: {
      id: turma.id,
      nome: turma.turma_nome,
      classe: turma.classe_nome,
      secao: turma.secao_nome || null,
      turno: turma.turno_nome || null,
      diretor_turma: turma.professor_titular_nome || null,
    },
    config_academica: configAcademica,
    disciplinas: disciplinas.map((d) => ({
      id: d.id,
      nome: d.nome,
      professores: professorNomesPorDisciplina[d.id] || [],
      professor_label: (professorNomesPorDisciplina[d.id] || []).join(' / ') || null,
    })),
    periodos_labels: PERIODOS.map((p) => LABEL_TRIMESTRE[p]),
    alunos: linhasAlunos,
    resumo,
    tem_disciplinas: disciplinas.length > 0,
    tem_alunos: alunos.length > 0,
  };
};

/**
 * GET /schools/:schoolId/turmas/:turmaId/pauta-frequencia
 */
export const getPautaFrequenciaTurma = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await montarPautaFrequenciaTurma(schoolId, turmaId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    res.json({ success: true, ...dados });
  } catch (err) {
    console.error('[v0] Erro ao montar a Pauta de Frequência e Resultados:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar a Pauta de Frequência e Resultados', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EXPORTAÇÃO — PDF (paisagem, cabeçalho hierárquico repetido em cada página)
 * ═══════════════════════════════════════════════════════════════════════
 */
const CORES_RESULTADO = {
  TRANSITA: '#059669', APROVADO: '#059669',
  NAO_TRANSITA: '#dc2626', REPROVADO: '#dc2626',
  PENDENTE: '#b45309', EXCLUIDO: '#7c3aed',
};

// Ajusta um texto à largura disponível SEM cortar arbitrariamente por número
// fixo de caracteres — mede a largura real do texto (que varia por letra) e
// só corta, com reticências, quando genuinamente não cabe. Isto evita tanto
// nomes/disciplinas cortados sem necessidade (texto curto que cabia inteiro
// mas era truncado por um limite fixo de caracteres) como texto a transbordar
// da célula (texto comprido que precisa de reticências).
const ajustarTextoALargura = (doc, texto, largura) => {
  const original = String(texto ?? '');
  if (doc.widthOfString(original) <= largura) return original;
  let resultado = original;
  while (resultado.length > 1 && doc.widthOfString(`${resultado}…`) > largura) {
    resultado = resultado.slice(0, -1);
  }
  return `${resultado}…`;
};

export const gerarPautaFrequenciaPDF = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await montarPautaFrequenciaTurma(schoolId, turmaId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    if (!dados.tem_disciplinas) {
      return res.status(400).json({ success: false, message: 'Esta turma ainda não tem disciplinas configuradas — configure o currículo na aba Disciplinas antes de exportar a pauta.' });
    }
    if (!dados.tem_alunos) {
      return res.status(400).json({ success: false, message: 'Esta turma ainda não tem alunos ativos.' });
    }

    const { escola, ano_letivo: anoLetivo, turma, disciplinas, alunos, resumo, config_academica: configAcademica } = dados;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pauta-frequencia-${(turma.nome || 'turma').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 18 });
    doc.pipe(res);
    const larguraUtil = doc.page.width - 36;

    // ── Cabeçalho oficial (secção 15 do pedido) ─────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#475569').text('REPÚBLICA DE MOÇAMBIQUE', { align: 'center' });
    doc.fontSize(8).text('MINISTÉRIO DA EDUCAÇÃO', { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text(escola.nome || 'Escola', { align: 'center' });
    if (escola.endereco) doc.fontSize(8).font('Helvetica').fillColor('#475569').text(escola.endereco, { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text('PAUTA DE FREQUÊNCIA E RESULTADOS', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#334155').text(
      `Ano Lectivo: ${anoLetivo}    Classe: ${turma.classe || '—'}    Turma: ${turma.nome || '—'}` +
      `${turma.secao ? `    Secção: ${turma.secao}` : ''}${turma.turno ? `    Turno: ${turma.turno}` : ''}`,
      { align: 'center' }
    );
    if (turma.diretor_turma) {
      doc.fontSize(9).text(`Director(a) de Turma: ${turma.diretor_turma}`, { align: 'center' });
    }
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#64748b').text(
      configAcademica.fonte === 'sugestao_automatica'
        ? `Terminologia de resultado: ${configAcademica.possui_exame ? 'Aprovado/Reprovado' : 'Transita/Não Transita'} (sugestão automática — confirme em Configurações / Configuração Académica)`
        : `Terminologia de resultado: ${configAcademica.possui_exame ? 'Aprovado/Reprovado' : 'Transita/Não Transita'} (configurado pela escola)`,
      { align: 'center' }
    );
    doc.moveDown(0.5);
    doc.strokeColor('#94a3b8').moveTo(18, doc.y).lineTo(18 + larguraUtil, doc.y).stroke();
    doc.moveDown(0.4);

    // ── Layout de colunas ────────────────────────────────────────────────
    // Margem reduzida (18pt) para ganhar largura útil — importante para caber
    // o nome completo das disciplinas e dos alunos sem cortes desnecessários.
    const margem = 18;
    const larguraPagina = doc.page.width - margem * 2;
    const colNumero = 20, colGenero = 24, colMediaGeral = 40, colResultado = 58;
    const colNome = Math.max(110, Math.min(160, larguraPagina * 0.16));
    const larguraFixas = colNumero + colNome + colGenero + colMediaGeral + colResultado;
    const alturaCabecalho1 = 15, alturaCabecalho2 = 22;
    const xInicioDisciplinas = margem + colNumero + colNome + colGenero;
    const alturaLinha = 15;

    // ── Divisão em grupos de disciplinas (turmas com muitas disciplinas) ──
    // Uma turma do Ensino Secundário moçambicano facilmente tem 10-14
    // disciplinas — 4 subcolunas cada não cabem todas lado a lado numa só
    // página A4, mesmo em paisagem. Em vez de espremer as colunas até ficarem
    // ilegíveis (ou pior, cortar a tabela fora da página, que era exatamente
    // o problema "não sai toda a informação"), a pauta divide as disciplinas
    // em blocos de páginas — cada bloco repete N.º/Nome/Género (para as
    // páginas continuarem identificáveis) e mostra Média Geral/Resultado
    // apenas no último bloco, que é o único com a informação completa do
    // aluno para decidir o veredito.
    const disponivelParaDisciplinas = larguraPagina - larguraFixas;
    const LARGURA_MIN_DISCIPLINA = 54; // ainda legível com fonte pequena (4 subcolunas)
    const discPorPagina = Math.max(1, Math.floor(disponivelParaDisciplinas / LARGURA_MIN_DISCIPLINA));
    const gruposDisciplinas = [];
    for (let i = 0; i < disciplinas.length; i += discPorPagina) {
      gruposDisciplinas.push(disciplinas.slice(i, i + discPorPagina));
    }

    gruposDisciplinas.forEach((grupo, indiceGrupo) => {
      const ultimoGrupo = indiceGrupo === gruposDisciplinas.length - 1;
      const larguraColunasFixasGrupo = colNumero + colNome + colGenero + (ultimoGrupo ? colMediaGeral + colResultado : 0);
      const larguraPorDisciplina = (larguraPagina - larguraColunasFixasGrupo) / grupo.length;
      const colTrimestre = larguraPorDisciplina / 4;
      // Fonte da tabela reduz consoante o número de disciplinas do bloco —
      // mas o texto nunca é cortado a um número fixo de caracteres, só por
      // reticências quando genuinamente não cabe (ver ajustarTextoALargura).
      const fonteTabela = grupo.length > 10 ? 5 : grupo.length > 8 ? 5.5 : grupo.length > 5 ? 6.5 : 7.5;

      if (indiceGrupo > 0) {
        doc.addPage();
        doc.y = margem;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text(
          `Pauta de Frequência e Resultados — ${turma.nome || ''} (continuação: disciplinas ${indiceGrupo * discPorPagina + 1} a ${indiceGrupo * discPorPagina + grupo.length} de ${disciplinas.length})`,
          margem, doc.y, { width: larguraPagina }
        );
        doc.moveDown(0.4);
      }

      // Desenha a grelha completa (linhas horizontais e verticais) de um
      // bloco de linhas da tabela — dá o aspeto "bem bordado" pedido, em vez
      // de apenas linhas verticais a separar grupos de disciplinas.
      const desenharGrelha = (yTopo, alturaTotal, alturasLinha) => {
        doc.strokeColor('#94a3b8').lineWidth(0.5);
        const xs = [margem, margem + colNumero, margem + colNumero + colNome, xInicioDisciplinas];
        let x = xInicioDisciplinas;
        grupo.forEach(() => {
          for (let i = 0; i < 4; i += 1) { xs.push(x); x += colTrimestre; }
        });
        if (ultimoGrupo) {
          xs.push(x); // média geral
          xs.push(x + colMediaGeral); // resultado
          xs.push(x + colMediaGeral + colResultado); // borda direita
        } else {
          xs.push(x); // borda direita (sem média geral/resultado neste bloco)
        }
        xs.forEach((xLinha) => doc.moveTo(xLinha, yTopo).lineTo(xLinha, yTopo + alturaTotal).stroke());
        let yLinha = yTopo;
        doc.moveTo(margem, yLinha).lineTo(margem + larguraPagina, yLinha).stroke();
        alturasLinha.forEach((h) => {
          yLinha += h;
          doc.moveTo(margem, yLinha).lineTo(margem + larguraPagina, yLinha).stroke();
        });
      };

      const desenharCabecalho = () => {
        const yTopo = doc.y;
        // Linha 1: nome completo da disciplina (célula mesclada visualmente sobre as 4 subcolunas)
        doc.rect(margem, yTopo, larguraPagina, alturaCabecalho1).fill('#1e293b');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fonteTabela);
        let x = xInicioDisciplinas;
        grupo.forEach((disc) => {
          const texto = ajustarTextoALargura(doc, disc.nome.toUpperCase(), larguraPorDisciplina - 4);
          doc.text(texto, x + 2, yTopo + 4.5, { width: larguraPorDisciplina - 4, align: 'center', lineBreak: false });
          x += larguraPorDisciplina;
        });
        // Linha 2: subcabeçalhos fixos + trimestres
        const ySub = yTopo + alturaCabecalho1;
        doc.rect(margem, ySub, larguraPagina, alturaCabecalho2).fill('#334155');
        doc.fillColor('#ffffff');
        let x2 = margem;
        doc.text('N.º', x2, ySub + 7, { width: colNumero, align: 'center' }); x2 += colNumero;
        doc.text('Nome Completo', x2 + 3, ySub + 7, { width: colNome - 4, lineBreak: false }); x2 += colNome;
        doc.text('Gén.', x2, ySub + 7, { width: colGenero, align: 'center' }); x2 += colGenero;
        grupo.forEach(() => {
          ['1.º', '2.º', '3.º', 'Méd.'].forEach((lbl) => {
            doc.text(lbl, x2, ySub + 7, { width: colTrimestre, align: 'center' });
            x2 += colTrimestre;
          });
        });
        if (ultimoGrupo) {
          doc.text('Média Geral', x2, ySub + 4, { width: colMediaGeral, align: 'center' }); x2 += colMediaGeral;
          doc.text('Resultado', x2, ySub + 7, { width: colResultado, align: 'center' });
        }

        const alturaTotalCabecalho = alturaCabecalho1 + alturaCabecalho2;
        desenharGrelha(yTopo, alturaTotalCabecalho, [alturaCabecalho1, alturaCabecalho2]);
        doc.strokeColor('#1e293b').lineWidth(0.8).rect(margem, yTopo, larguraPagina, alturaTotalCabecalho).stroke();
        doc.y = ySub + alturaCabecalho2;
      };

      desenharCabecalho();

      alunos.forEach((aluno, i) => {
        if (doc.y + alturaLinha > doc.page.height - 90) {
          doc.addPage();
          doc.y = margem;
          desenharCabecalho();
        }
        const yLinha = doc.y;
        if (i % 2 === 1) doc.rect(margem, yLinha, larguraPagina, alturaLinha).fill('#f8fafc');
        doc.fillColor('#1e293b').font('Helvetica').fontSize(fonteTabela);
        let x = margem;
        doc.text(String(aluno.numero), x, yLinha + 4, { width: colNumero, align: 'center' }); x += colNumero;
        doc.text(ajustarTextoALargura(doc, aluno.nome, colNome - 6), x + 3, yLinha + 4, { width: colNome - 6, lineBreak: false }); x += colNome;
        doc.text(aluno.genero ? aluno.genero[0] : '—', x, yLinha + 4, { width: colGenero, align: 'center' }); x += colGenero;
        grupo.forEach((discGrupo) => {
          const disc = aluno.disciplinas.find((d) => d.disciplina_id === discGrupo.id);
          const trimestres = disc?.trimestres || [null, null, null];
          [...trimestres, disc?.media_geral].forEach((valor) => {
            doc.text(valor != null ? valor.toFixed(1) : '—', x, yLinha + 4, { width: colTrimestre, align: 'center' });
            x += colTrimestre;
          });
        });
        if (ultimoGrupo) {
          doc.font('Helvetica-Bold').text(aluno.media_geral != null ? aluno.media_geral.toFixed(1) : '—', x, yLinha + 4, { width: colMediaGeral, align: 'center' });
          x += colMediaGeral;
          doc.fillColor(CORES_RESULTADO[aluno.resultado] || '#1e293b').text(aluno.resultado_label, x, yLinha + 4, { width: colResultado, align: 'center' });
        }
        doc.y = yLinha + alturaLinha;
        desenharGrelha(yLinha, alturaLinha, [alturaLinha]);
      });
    });

    // ── Resumo da turma ──────────────────────────────────────────────────
    if (doc.y > doc.page.height - 130) { doc.addPage(); doc.y = margem; }
    doc.moveDown(1);
    doc.strokeColor('#e2e8f0').moveTo(margem, doc.y).lineTo(margem + larguraUtil, doc.y).stroke();
    doc.moveDown(0.4);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text('Resumo da Turma', margem, doc.y);
    doc.moveDown(0.2);
    doc.fontSize(8).font('Helvetica').fillColor('#334155');
    const partesResumo = [
      `Total de alunos: ${resumo.total_alunos}`,
      `Masculinos: ${resumo.masculinos}`,
      `Femininas: ${resumo.femininos}`,
      configAcademica.possui_exame ? `Aprovados: ${resumo.total_aprovado}` : `Transita: ${resumo.total_transita}`,
      configAcademica.possui_exame ? `Reprovados: ${resumo.total_reprovado}` : `Não Transita: ${resumo.total_nao_transita}`,
      `Pendentes: ${resumo.total_pendente}`,
      resumo.total_excluido > 0 ? `Excluídos por faltas: ${resumo.total_excluido}` : null,
      `Média geral da turma: ${resumo.media_geral_turma != null ? resumo.media_geral_turma.toFixed(1) : '—'}`,
    ].filter(Boolean).join('   ·   ');
    doc.text(partesResumo, margem, doc.y, { width: larguraUtil });

    // ── Confirmação de notas por disciplina (secção pedida por Carlos) ────
    // Uma linha por disciplina, com o(s) professor(es) que a leciona(m) nesta
    // turma e TRÊS espaços de assinatura — um por trimestre — para o
    // professor confirmar, no fim do trimestre, que as notas lançadas nesta
    // pauta são as reais. Isto é distinto das assinaturas finais de Director
    // de Turma/Escola: aqui cada disciplina é confirmada pelo seu professor.
    doc.moveDown(1.2);
    if (doc.y > doc.page.height - (60 + disciplinas.length * 20)) { doc.addPage(); doc.y = margem; }
    doc.strokeColor('#e2e8f0').moveTo(margem, doc.y).lineTo(margem + larguraUtil, doc.y).stroke();
    doc.moveDown(0.4);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e293b').text(
      'Confirmação das Notas por Disciplina — Assinatura do(a) Professor(a)', margem, doc.y
    );
    doc.moveDown(0.15);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#64748b').text(
      'Cada professor(a) assina, no fim de cada trimestre, confirmando que as notas lançadas na disciplina que lecciona são reais.',
      margem, doc.y
    );
    doc.moveDown(0.35);

    const colDisc = larguraUtil * 0.24, colProf = larguraUtil * 0.24;
    const colTrim3 = (larguraUtil - colDisc - colProf) / 3;
    const alturaLinhaAss = 24;

    const desenharCabecalhoAssinaturas = () => {
      const yT = doc.y;
      doc.rect(margem, yT, larguraUtil, 14).fill('#334155');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
      let x = margem;
      doc.text('Disciplina', x + 3, yT + 4, { width: colDisc - 4 }); x += colDisc;
      doc.text('Professor(a)', x + 3, yT + 4, { width: colProf - 4 }); x += colProf;
      ['Assinatura 1.º Trim.', 'Assinatura 2.º Trim.', 'Assinatura 3.º Trim.'].forEach((lbl) => {
        doc.text(lbl, x, yT + 4, { width: colTrim3, align: 'center' });
        x += colTrim3;
      });
      doc.strokeColor('#94a3b8').lineWidth(0.5).rect(margem, yT, larguraUtil, 14).stroke();
      doc.y = yT + 14;
    };

    desenharCabecalhoAssinaturas();
    disciplinas.forEach((disc) => {
      if (doc.y + alturaLinhaAss > doc.page.height - 30) {
        doc.addPage();
        doc.y = margem;
        desenharCabecalhoAssinaturas();
      }
      const yL = doc.y;
      doc.strokeColor('#cbd5e1').lineWidth(0.5).rect(margem, yL, larguraUtil, alturaLinhaAss).stroke();
      let x = margem;
      doc.moveTo(x + colDisc, yL).lineTo(x + colDisc, yL + alturaLinhaAss).stroke();
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(7.5)
        .text(ajustarTextoALargura(doc, disc.nome, colDisc - 6), x + 3, yL + 8, { width: colDisc - 6, lineBreak: false });
      x += colDisc;
      doc.moveTo(x + colProf, yL).lineTo(x + colProf, yL + alturaLinhaAss).stroke();
      doc.font('Helvetica').fillColor('#334155')
        .text(ajustarTextoALargura(doc, disc.professor_label || '—', colProf - 6), x + 3, yL + 8, { width: colProf - 6, lineBreak: false });
      x += colProf;
      [0, 1, 2].forEach((i) => {
        if (i > 0) doc.strokeColor('#cbd5e1').moveTo(x, yL).lineTo(x, yL + alturaLinhaAss).stroke();
        doc.strokeColor('#94a3b8').lineWidth(0.6)
          .moveTo(x + 8, yL + alturaLinhaAss - 6).lineTo(x + colTrim3 - 8, yL + alturaLinhaAss - 6).stroke();
        x += colTrim3;
      });
      doc.y = yL + alturaLinhaAss;
    });

    // ── Assinaturas finais (Director de Turma / Director da Escola) ───────
    if (doc.y > doc.page.height - 90) { doc.addPage(); doc.y = margem; }
    doc.moveDown(2);
    const yAss = doc.y;
    const largAss = 200;
    doc.strokeColor('#334155').lineWidth(0.7)
      .moveTo(margem + 30, yAss).lineTo(margem + 30 + largAss, yAss).stroke()
      .moveTo(margem + larguraUtil - largAss - 30, yAss).lineTo(margem + larguraUtil - 30, yAss).stroke();
    doc.fontSize(8.5).font('Helvetica').fillColor('#334155');
    doc.text('O(A) Director(a) de Turma', margem + 30, yAss + 4, { width: largAss, align: 'center' });
    doc.text('O(A) Director(a) da Escola', margem + larguraUtil - largAss - 30, yAss + 4, { width: largAss, align: 'center' });

    doc.moveDown(2);
    doc.fontSize(7).font('Helvetica').fillColor('#94a3b8').text(
      `Gerado automaticamente pelo FalconEducation em ${new Date().toLocaleString('pt-PT')}. Consulte o Regulamento de Avaliação vigente antes de submeter este documento como pauta oficial.`,
      { align: 'center' }
    );

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar PDF da Pauta de Frequência:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar PDF da Pauta de Frequência', error: err.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EXPORTAÇÃO — EXCEL (cabeçalho hierárquico com células mescladas)
 * ═══════════════════════════════════════════════════════════════════════
 */
export const gerarPautaFrequenciaExcel = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await montarPautaFrequenciaTurma(schoolId, turmaId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    if (!dados.tem_disciplinas || !dados.tem_alunos) {
      return res.status(400).json({ success: false, message: 'Esta turma ainda não tem disciplinas ou alunos suficientes para exportar.' });
    }

    const { escola, ano_letivo: anoLetivo, turma, disciplinas, alunos, resumo, config_academica: configAcademica } = dados;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FalconEducation';
    const sheet = workbook.addWorksheet('Pauta', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 } });

    const COL_FIXAS = 3; // N.º, Nome, Género
    const totalColunasDisciplinas = disciplinas.length * 4;
    const colMediaGeral = COL_FIXAS + totalColunasDisciplinas + 1;
    const colResultado = colMediaGeral + 1;

    // Cabeçalho institucional
    sheet.mergeCells(1, 1, 1, colResultado);
    sheet.getCell(1, 1).value = escola.nome || 'Escola';
    sheet.getCell(1, 1).font = { bold: true, size: 14 };
    sheet.getCell(1, 1).alignment = { horizontal: 'center' };

    sheet.mergeCells(2, 1, 2, colResultado);
    sheet.getCell(2, 1).value = 'PAUTA DE FREQUÊNCIA E RESULTADOS';
    sheet.getCell(2, 1).font = { bold: true, size: 12 };
    sheet.getCell(2, 1).alignment = { horizontal: 'center' };

    sheet.mergeCells(3, 1, 3, colResultado);
    sheet.getCell(3, 1).value =
      `Ano Lectivo: ${anoLetivo}    Classe: ${turma.classe || '—'}    Turma: ${turma.nome || '—'}` +
      `${turma.secao ? `    Secção: ${turma.secao}` : ''}${turma.turno ? `    Turno: ${turma.turno}` : ''}` +
      `${turma.diretor_turma ? `    Director(a) de Turma: ${turma.diretor_turma}` : ''}`;
    sheet.getCell(3, 1).alignment = { horizontal: 'center' };
    sheet.getCell(3, 1).font = { italic: true, size: 9 };

    const LINHA_CABECALHO_1 = 5;
    const LINHA_CABECALHO_2 = 6;

    // Cabeçalho fixo (N.º / Nome / Género) — mescla vertical das duas linhas de cabeçalho
    const cabecalhoFixo = [
      { titulo: 'N.º', largura: 6 },
      { titulo: 'Nome Completo', largura: 32 },
      { titulo: 'Género', largura: 10 },
    ];
    cabecalhoFixo.forEach((c, i) => {
      const col = i + 1;
      sheet.mergeCells(LINHA_CABECALHO_1, col, LINHA_CABECALHO_2, col);
      const cell = sheet.getCell(LINHA_CABECALHO_1, col);
      cell.value = c.titulo;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      aplicarBorda(cell);
      sheet.getColumn(col).width = c.largura;
    });

    // Cabeçalho por disciplina — linha 1 mesclada (nome), linha 2 com os 4 subcabeçalhos
    let colAtual = COL_FIXAS + 1;
    disciplinas.forEach((disc) => {
      sheet.mergeCells(LINHA_CABECALHO_1, colAtual, LINHA_CABECALHO_1, colAtual + 3);
      const cabecalhoDisc = sheet.getCell(LINHA_CABECALHO_1, colAtual);
      cabecalhoDisc.value = disc.nome.toUpperCase();
      cabecalhoDisc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cabecalhoDisc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cabecalhoDisc.alignment = { horizontal: 'center', vertical: 'middle' };
      aplicarBorda(cabecalhoDisc);
      for (let k = 0; k < 4; k += 1) aplicarBorda(sheet.getCell(LINHA_CABECALHO_1, colAtual + k));

      ['1.º Trim.', '2.º Trim.', '3.º Trim.', 'Média'].forEach((sub, j) => {
        const cell = sheet.getCell(LINHA_CABECALHO_2, colAtual + j);
        cell.value = sub;
        cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        aplicarBorda(cell);
        sheet.getColumn(colAtual + j).width = 9;
      });
      colAtual += 4;
    });

    // Média Geral / Resultado
    [{ titulo: 'Média Geral', col: colMediaGeral, largura: 12 }, { titulo: 'Resultado', col: colResultado, largura: 16 }].forEach((c) => {
      sheet.mergeCells(LINHA_CABECALHO_1, c.col, LINHA_CABECALHO_2, c.col);
      const cell = sheet.getCell(LINHA_CABECALHO_1, c.col);
      cell.value = c.titulo;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      aplicarBorda(cell);
      sheet.getColumn(c.col).width = c.largura;
    });

    // Linhas dos alunos
    let linha = LINHA_CABECALHO_2 + 1;
    alunos.forEach((aluno, i) => {
      const valoresFixos = [aluno.numero, aluno.nome, aluno.genero || '—'];
      const valoresDisciplinas = aluno.disciplinas.flatMap((d) => [
        d.trimestres[0], d.trimestres[1], d.trimestres[2], d.media_geral,
      ].map((v) => (v != null ? v : '—')));
      const row = sheet.getRow(linha);
      [...valoresFixos, ...valoresDisciplinas, aluno.media_geral != null ? aluno.media_geral : '—', aluno.resultado_label]
        .forEach((valor, idx) => { row.getCell(idx + 1).value = valor; });
      row.getCell(colResultado).font = { bold: true, color: { argb: corExcelResultado(aluno.resultado) } };
      row.getCell(colMediaGeral).font = { bold: true };
      row.alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
      if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      });
      for (let col = 1; col <= colResultado; col += 1) aplicarBorda(row.getCell(col));
      linha += 1;
    });

    // Resumo da turma
    linha += 1;
    sheet.getCell(linha, 1).value = 'Resumo da Turma';
    sheet.getCell(linha, 1).font = { bold: true };
    linha += 1;
    const linhasResumo = [
      ['Total de alunos', resumo.total_alunos],
      ['Masculinos', resumo.masculinos],
      ['Femininas', resumo.femininos],
      configAcademica.possui_exame ? ['Aprovados', resumo.total_aprovado] : ['Transita', resumo.total_transita],
      configAcademica.possui_exame ? ['Reprovados', resumo.total_reprovado] : ['Não Transita', resumo.total_nao_transita],
      ['Pendentes', resumo.total_pendente],
      ['Excluídos por faltas', resumo.total_excluido],
      ['Média geral da turma', resumo.media_geral_turma != null ? resumo.media_geral_turma : '—'],
    ];
    linhasResumo.forEach(([label, valor]) => {
      sheet.getCell(linha, 1).value = label;
      sheet.getCell(linha, 2).value = valor;
      linha += 1;
    });

    // ── Confirmação de notas por disciplina — assinatura do(a) professor(a) ──
    // Uma linha por disciplina com o(s) professor(es) e três colunas em branco
    // (uma por trimestre) para a assinatura física após impressão, tal como
    // no PDF. Mantém o mesmo conceito — o professor confirma que as notas da
    // sua disciplina são reais — para quem preferir tratar isto em Excel.
    linha += 2;
    sheet.mergeCells(linha, 1, linha, colResultado);
    const tituloAss = sheet.getCell(linha, 1);
    tituloAss.value = 'Confirmação das Notas por Disciplina — Assinatura do(a) Professor(a)';
    tituloAss.font = { bold: true, size: 11 };
    linha += 1;
    sheet.mergeCells(linha, 1, linha, colResultado);
    const notaAss = sheet.getCell(linha, 1);
    notaAss.value = 'Cada professor(a) assina, no fim de cada trimestre, confirmando que as notas lançadas na disciplina que lecciona são reais.';
    notaAss.font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
    linha += 1;

    const linhaCabAss = linha;
    const cabecalhoAss = ['Disciplina', 'Professor(a)', 'Assinatura 1.º Trimestre', 'Assinatura 2.º Trimestre', 'Assinatura 3.º Trimestre'];
    cabecalhoAss.forEach((titulo, idx) => {
      const cell = sheet.getCell(linhaCabAss, idx + 1);
      cell.value = titulo;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      aplicarBorda(cell);
    });
    linha += 1;

    disciplinas.forEach((disc) => {
      const row = sheet.getRow(linha);
      row.getCell(1).value = disc.nome;
      row.getCell(1).font = { bold: true };
      row.getCell(2).value = disc.professor_label || '—';
      row.getCell(3).value = '';
      row.getCell(4).value = '';
      row.getCell(5).value = '';
      row.height = 28;
      for (let col = 1; col <= 5; col += 1) {
        const cell = row.getCell(col);
        aplicarBorda(cell);
        cell.alignment = { horizontal: col <= 2 ? 'left' : 'center', vertical: 'middle' };
      }
      linha += 1;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pauta-frequencia-${(turma.nome || 'turma').replace(/[^a-z0-9]+/gi, '-')}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar Excel da Pauta de Frequência:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar Excel da Pauta de Frequência', error: err.message });
  }
};

// Borda fina preta aplicada a todos os lados de uma célula — usada em toda a
// tabela (cabeçalho, corpo e secção de assinaturas) para dar o aspeto "bem
// bordado" pedido em todos os formatos.
const BORDA_FINA = { style: 'thin', color: { argb: 'FF334155' } };
const aplicarBorda = (cell) => {
  cell.border = { top: BORDA_FINA, left: BORDA_FINA, bottom: BORDA_FINA, right: BORDA_FINA };
};

const corExcelResultado = (estado) => ({
  TRANSITA: 'FF059669', APROVADO: 'FF059669',
  NAO_TRANSITA: 'FFDC2626', REPROVADO: 'FFDC2626',
  PENDENTE: 'FFB45309', EXCLUIDO: 'FF7C3AED',
}[estado] || 'FF1E293B');

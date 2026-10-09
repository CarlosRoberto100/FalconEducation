import db from '../config/db.js';
import PDFDocument from 'pdfkit';
import { ensurePresencasTableExists } from './attendanceController.js';
import { ensureTabelasHorario } from './horarioController.js';
import { ensureFuncionariosTableExists } from './funcionarioController.js';
import { ensurePaymentColumnsExist } from '../services/financialStatusService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOTOR DE RELATÓRIOS CONFIGURÁVEL (REPORT BUILDER)
// ─────────────────────────────────────────────────────────────────────────────
// Diferente da aba "Relatórios" antiga (cards fixos, um CSV pronto por
// botão), isto deixa o próprio administrador escolher: de onde vêm os dados
// (dataset), quais colunas quer ver, que filtros aplicar, e opcionalmente
// agrupar/agregar — tudo antes de exportar para Excel ou PDF.
//
// 🔒 SEGURANÇA: nunca se interpola texto vindo do pedido diretamente no SQL.
// Cada dataset define um mapa fixo (whitelist) de "chave lógica" → expressão
// SQL real. O frontend só pode escolher chaves que existem nesse mapa; tudo o
// resto (valores de filtro, operadores) entra sempre como parâmetro
// preparado (`?`), nunca concatenado na string da query.
// ═══════════════════════════════════════════════════════════════════════════════

const OPERADORES_POR_TIPO = {
  text: ['contem', 'igual', 'comeca_com'],
  number: ['igual', 'maior_que', 'maior_igual', 'menor_que', 'menor_igual', 'entre'],
  date: ['igual', 'depois_de', 'antes_de', 'entre'],
  select: ['igual', 'em'],
};

// Cada dataset: { label, from (FROM ... JOIN ... — sempre termina antes do WHERE),
// whereBase (condição fixa aplicada sempre, com os parâmetros em whereBaseParams),
// fields: { chave: { label, sql, type, groupable, aggregatable, options? } },
// ensureTabelas: função opcional a correr antes (auto-migração) }
const DATASETS = {
  alunos: {
    label: 'Alunos',
    ensureTabelas: async () => { await Promise.all([ensureTabelasHorario(), ensurePaymentColumnsExist()]); },
    from: `
      FROM students s
      LEFT JOIN turmas t ON s.turma_id = t.id
      LEFT JOIN classes c ON c.id = t.class_id
      LEFT JOIN (
        SELECT
          sp.student_id,
          SUM(CASE WHEN sp.status = 'atrasado' THEN sp.valor_original + COALESCE(sp.multa, 0) ELSE 0 END) as total_atrasado,
          SUM(CASE WHEN sp.status = 'pendente' THEN sp.valor_original + COALESCE(sp.multa, 0) ELSE 0 END) as total_pendente
        FROM student_payments sp
        WHERE sp.school_id = ?
        GROUP BY sp.student_id
      ) fin ON fin.student_id = s.id
    `,
    fromParams: (schoolId) => [schoolId],
    whereBase: `s.school_id = ?`,
    whereBaseParams: (schoolId) => [schoolId],
    fields: {
      nome: { label: 'Nome', sql: 's.nome', type: 'text' },
      codigo_aluno: { label: 'Código do Aluno', sql: 's.codigo_aluno', type: 'text' },
      genero: { label: 'Género', sql: 's.genero', type: 'select', options: ['M', 'F'], groupable: true },
      data_nascimento: { label: 'Data de Nascimento', sql: 's.data_nascimento', type: 'date' },
      turma_nome: { label: 'Turma', sql: 't.nome', type: 'text', groupable: true },
      classe_nome: { label: 'Classe', sql: 'c.nome', type: 'text', groupable: true },
      status: { label: 'Status', sql: 's.status', type: 'select', options: ['ativo', 'inativo', 'suspenso', 'evadido'], groupable: true },
      email: { label: 'Email', sql: 's.email', type: 'text' },
      telefone: { label: 'Telefone', sql: 's.telefone', type: 'text' },
      data_inscricao: { label: 'Data de Inscrição', sql: 's.data_inscricao', type: 'date' },
      total_atrasado: { label: 'Total em Atraso (MZN)', sql: 'COALESCE(fin.total_atrasado, 0)', type: 'number', aggregatable: true },
      total_pendente: { label: 'Total Pendente (MZN)', sql: 'COALESCE(fin.total_pendente, 0)', type: 'number', aggregatable: true },
    },
    defaultSort: 's.nome',
  },

  financeiro: {
    label: 'Financeiro (Mensalidades)',
    ensureTabelas: async () => { await ensurePaymentColumnsExist(); },
    from: `
      FROM student_payments sp
      INNER JOIN students s ON s.id = sp.student_id
      LEFT JOIN turmas t ON s.turma_id = t.id
      LEFT JOIN mensalidades m ON m.id = sp.mensalidade_id
    `,
    whereBase: `sp.school_id = ?`,
    whereBaseParams: (schoolId) => [schoolId],
    fields: {
      aluno_nome: { label: 'Aluno', sql: 's.nome', type: 'text' },
      turma_nome: { label: 'Turma', sql: 't.nome', type: 'text', groupable: true },
      mensalidade_tipo: { label: 'Tipo', sql: 'm.tipo', type: 'text', groupable: true },
      valor_original: { label: 'Valor Original (MZN)', sql: 'sp.valor_original', type: 'number', aggregatable: true },
      multa: { label: 'Multa (MZN)', sql: 'COALESCE(sp.multa, 0)', type: 'number', aggregatable: true },
      valor_pago: { label: 'Valor Pago (MZN)', sql: 'COALESCE(sp.valor_pago, 0)', type: 'number', aggregatable: true },
      status: { label: 'Status', sql: 'sp.status', type: 'select', options: ['pendente', 'atrasado', 'pago', 'estornado'], groupable: true },
      data_vencimento: { label: 'Data de Vencimento', sql: 'sp.data_vencimento', type: 'date' },
      data_pagamento: { label: 'Data de Pagamento', sql: 'sp.data_pagamento', type: 'date' },
    },
    defaultSort: 'sp.data_vencimento',
  },

  funcionarios: {
    label: 'Funcionários',
    ensureTabelas: async () => { await ensureFuncionariosTableExists(); },
    from: `FROM funcionarios f`,
    whereBase: `f.school_id = ?`,
    whereBaseParams: (schoolId) => [schoolId],
    fields: {
      nome: { label: 'Nome', sql: 'f.nome', type: 'text' },
      cargo: { label: 'Cargo', sql: 'f.cargo', type: 'text', groupable: true },
      nuit: { label: 'NUIT', sql: 'f.nuit', type: 'text' },
      tipo_contrato: { label: 'Tipo de Contrato', sql: 'f.tipo_contrato', type: 'text', groupable: true },
      salario: { label: 'Salário (MZN)', sql: 'f.salario', type: 'number', aggregatable: true },
      data_admissao: { label: 'Data de Admissão', sql: 'f.data_admissao', type: 'date' },
      status: { label: 'Status', sql: `CASE WHEN f.ativo = 1 THEN 'Ativo' ELSE 'Arquivado' END`, type: 'select', options: ['Ativo', 'Arquivado'], groupable: true },
      telefone: { label: 'Telefone', sql: 'f.telefone', type: 'text' },
      email: { label: 'Email', sql: 'f.email', type: 'text' },
    },
    defaultSort: 'f.nome',
  },

  frequencia: {
    label: 'Frequência (Presenças)',
    ensureTabelas: async () => { await ensurePresencasTableExists(); },
    from: `
      FROM presencas p
      INNER JOIN students s ON s.id = p.student_id
      LEFT JOIN turmas t ON t.id = p.turma_id
    `,
    whereBase: `p.school_id = ?`,
    whereBaseParams: (schoolId) => [schoolId],
    fields: {
      aluno_nome: { label: 'Aluno', sql: 's.nome', type: 'text' },
      turma_nome: { label: 'Turma', sql: 't.nome', type: 'text', groupable: true },
      data: { label: 'Data', sql: 'p.data', type: 'date' },
      status: { label: 'Status', sql: 'p.status', type: 'select', options: ['presente', 'falta', 'atraso', 'justificada'], groupable: true },
      observacao: { label: 'Observação', sql: 'p.observacao', type: 'text' },
    },
    defaultSort: 'p.data',
  },
};

/**
 * GET /schools/:schoolId/report-builder/datasets
 * Devolve o catálogo de datasets disponíveis e os campos de cada um, para o
 * frontend montar o formulário do construtor (sem precisar de nada estar
 * hardcoded dos dois lados).
 */
export const getDatasets = (req, res) => {
  const catalogo = Object.entries(DATASETS).map(([id, ds]) => ({
    id,
    label: ds.label,
    campos: Object.entries(ds.fields).map(([chave, f]) => ({
      chave,
      label: f.label,
      tipo: f.type,
      agrupavel: !!f.groupable,
      agregavel: !!f.aggregatable,
      opcoes: f.options || null,
      operadores: OPERADORES_POR_TIPO[f.type] || [],
    })),
  }));
  res.json({ success: true, data: catalogo });
};

const construirWhereEFiltros = (dataset, schoolId, filtros = []) => {
  let where = dataset.whereBase;
  const params = [...(dataset.whereBaseParams ? dataset.whereBaseParams(schoolId) : [])];

  (filtros || []).forEach((filtro) => {
    const campo = dataset.fields[filtro?.campo];
    if (!campo) return; // ignora silenciosamente chaves desconhecidas (nunca confia no que vem do pedido)
    const operadoresValidos = OPERADORES_POR_TIPO[campo.type] || [];
    if (!operadoresValidos.includes(filtro.operador)) return;

    switch (filtro.operador) {
      case 'contem':
        where += ` AND ${campo.sql} LIKE ?`;
        params.push(`%${filtro.valor}%`);
        break;
      case 'comeca_com':
        where += ` AND ${campo.sql} LIKE ?`;
        params.push(`${filtro.valor}%`);
        break;
      case 'igual':
        where += ` AND ${campo.sql} = ?`;
        params.push(filtro.valor);
        break;
      case 'em':
        if (Array.isArray(filtro.valores) && filtro.valores.length > 0) {
          where += ` AND ${campo.sql} IN (${filtro.valores.map(() => '?').join(',')})`;
          params.push(...filtro.valores);
        }
        break;
      case 'maior_que':
        where += ` AND ${campo.sql} > ?`;
        params.push(filtro.valor);
        break;
      case 'maior_igual':
        where += ` AND ${campo.sql} >= ?`;
        params.push(filtro.valor);
        break;
      case 'menor_que':
        where += ` AND ${campo.sql} < ?`;
        params.push(filtro.valor);
        break;
      case 'menor_igual':
        where += ` AND ${campo.sql} <= ?`;
        params.push(filtro.valor);
        break;
      case 'depois_de':
        where += ` AND ${campo.sql} > ?`;
        params.push(filtro.valor);
        break;
      case 'antes_de':
        where += ` AND ${campo.sql} < ?`;
        params.push(filtro.valor);
        break;
      case 'entre':
        where += ` AND ${campo.sql} BETWEEN ? AND ?`;
        params.push(filtro.valor, filtro.valor2);
        break;
      default:
        break;
    }
  });

  return { where, params };
};

const LIMITE_MAXIMO_LINHAS = 5000;

/**
 * Monta e executa a query do relatório a partir do payload do construtor.
 * Reutilizada tanto pela prévia (JSON) como pela exportação em PDF.
 */
const executarRelatorio = async (schoolId, { datasetId, campos, filtros, agruparPor, ordenarPor, ordenarDirecao }) => {
  const dataset = DATASETS[datasetId];
  if (!dataset) {
    const erro = new Error('Dataset de relatório desconhecido');
    erro.status = 400;
    throw erro;
  }

  if (dataset.ensureTabelas) {
    try { await dataset.ensureTabelas(); } catch (e) { /* segue sem bloquear — colunas ausentes viram null */ }
  }

  // Campos escolhidos: filtra para só os que existem no dataset (whitelist)
  const camposValidos = (campos && campos.length > 0 ? campos : Object.keys(dataset.fields))
    .filter((c) => dataset.fields[c]);
  if (camposValidos.length === 0) {
    const erro = new Error('Nenhum campo válido selecionado para o relatório');
    erro.status = 400;
    throw erro;
  }

  const { where, params } = construirWhereEFiltros(dataset, schoolId, filtros);

  const direcao = String(ordenarDirecao).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  if (agruparPor && dataset.fields[agruparPor]?.groupable) {
    const campoGrupo = dataset.fields[agruparPor];
    // Em modo agrupado: uma linha por valor do grupo, com contagem + soma/média
    // dos campos numéricos agregáveis que tiverem sido escolhidos.
    const agregados = camposValidos
      .filter((c) => dataset.fields[c].aggregatable && c !== agruparPor)
      .map((c) => `SUM(${dataset.fields[c].sql}) as soma_${c}, AVG(${dataset.fields[c].sql}) as media_${c}`)
      .join(', ');

    const sql = `
      SELECT ${campoGrupo.sql} as grupo, COUNT(*) as total ${agregados ? ', ' + agregados : ''}
      ${dataset.from}
      WHERE ${where}
      GROUP BY ${campoGrupo.sql}
      ORDER BY total DESC
      LIMIT ${LIMITE_MAXIMO_LINHAS}
    `;
    const linhas = await queryAsync(sql, params);
    return { agrupado: true, agrupadoPor: campoGrupo.label, linhas };
  }

  const selectSql = camposValidos.map((c) => `${dataset.fields[c].sql} as ${c}`).join(', ');
  const colunaOrdenacao = ordenarPor && dataset.fields[ordenarPor] ? dataset.fields[ordenarPor].sql : (dataset.defaultSort || camposValidos[0]);

  const sql = `
    SELECT ${selectSql}
    ${dataset.from}
    WHERE ${where}
    ORDER BY ${colunaOrdenacao} ${direcao}
    LIMIT ${LIMITE_MAXIMO_LINHAS}
  `;
  const linhas = await queryAsync(sql, params);
  return {
    agrupado: false,
    colunas: camposValidos.map((c) => ({ chave: c, label: dataset.fields[c].label })),
    linhas,
  };
};

/**
 * POST /schools/:schoolId/report-builder/run
 * Corre o relatório e devolve os dados em JSON (usado para a prévia na tela
 * e como base para a exportação em Excel, que é montada no próprio browser).
 */
export const runReportBuilder = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const resultado = await executarRelatorio(schoolId, req.body || {});
    res.json({
      success: true,
      truncado: !resultado.agrupado && resultado.linhas.length >= LIMITE_MAXIMO_LINHAS,
      ...resultado,
    });
  } catch (err) {
    console.error('[v0] Erro ao correr o Report Builder:', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Erro ao gerar relatório' });
  }
};

/**
 * POST /schools/:schoolId/report-builder/export-pdf
 * Mesmo payload do /run, mas devolve um PDF já formatado em tabela, pronto
 * para download — para quando o administrador quer algo para imprimir ou
 * anexar, em vez de continuar a trabalhar os dados em Excel.
 */
export const exportarReportBuilderPdf = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { datasetId, tituloPersonalizado } = req.body || {};
    const dataset = DATASETS[datasetId];
    const resultado = await executarRelatorio(schoolId, req.body || {});

    const colunas = resultado.agrupado
      ? [{ chave: 'grupo', label: resultado.agrupadoPor }, { chave: 'total', label: 'Total' }, ...Object.keys(resultado.linhas[0] || {}).filter((k) => k.startsWith('soma_') || k.startsWith('media_')).map((k) => ({ chave: k, label: k.replace('soma_', 'Soma: ').replace('media_', 'Média: ') }))]
      : resultado.colunas;

    const nomeArquivo = `relatorio_${datasetId}_${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);

    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: colunas.length > 5 ? 'landscape' : 'portrait' });
    doc.pipe(res);

    doc.fontSize(16).text(tituloPersonalizado || `Relatório — ${dataset?.label || datasetId}`, { align: 'left' });
    doc.fontSize(9).fillColor('#64748b').text(`Gerado em ${new Date().toLocaleString('pt-PT')}`, { align: 'left' });
    doc.moveDown(1);

    const larguraDisponivel = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const larguraColuna = larguraDisponivel / colunas.length;
    let y = doc.y;

    const desenharLinha = (valores, { negrito = false, corFundo = null } = {}) => {
      if (corFundo) {
        doc.rect(doc.page.margins.left, y - 2, larguraDisponivel, 18).fill(corFundo);
        doc.fillColor('#1e293b');
      }
      doc.fontSize(8.5).font(negrito ? 'Helvetica-Bold' : 'Helvetica');
      valores.forEach((valor, idx) => {
        doc.text(String(valor ?? '—'), doc.page.margins.left + idx * larguraColuna, y, { width: larguraColuna - 4, ellipsis: true });
      });
      y += 18;
      if (y > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ layout: colunas.length > 5 ? 'landscape' : 'portrait' });
        y = doc.page.margins.top;
      }
    };

    desenharLinha(colunas.map((c) => c.label), { negrito: true, corFundo: '#f1f5f9' });
    resultado.linhas.forEach((linha, idx) => {
      desenharLinha(colunas.map((c) => linha[c.chave]), { corFundo: idx % 2 === 0 ? '#ffffff' : '#f8fafc' });
    });

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao exportar Report Builder em PDF:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ success: false, message: err.message || 'Erro ao exportar relatório em PDF' });
    }
  }
};

import db from '../config/db.js';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { registrarAuditoria } from '../services/auditService.js';
import {
  listarCurriculoComExame,
  atualizarTemExameDisciplina,
  listarJurisDaTurma,
  gerarJurisAutomaticos,
  removerJuri,
  atualizarComportamentoMembro,
  atualizarEstadoJuri,
  montarDadosPautaExame,
} from '../services/pautaExameService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// GET /schools/:schoolId/turmas/:turmaId/curriculo-exame
export const getCurriculoComExame = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const dados = await listarCurriculoComExame(schoolId, turmaId);
    if (dados.erro) return res.status(dados.erro === 'Turma não encontrada' ? 404 : 400).json({ success: false, message: dados.erro });
    res.json({ success: true, ...dados });
  } catch (err) {
    console.error('[v0] Erro ao listar currículo com exame:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar currículo', error: err.message });
  }
};

// PATCH /schools/:schoolId/classes/:classeId/disciplinas/:disciplinaId/tem-exame
// Body: { tem_exame: boolean, secao_id?: number }
export const patchTemExameDisciplina = async (req, res) => {
  try {
    const { schoolId, classeId, disciplinaId } = req.params;
    const { tem_exame, secao_id = 0 } = req.body;
    const sucesso = await atualizarTemExameDisciplina(schoolId, classeId, Number(secao_id) || 0, disciplinaId, !!tem_exame);
    if (!sucesso) {
      return res.status(404).json({ success: false, message: 'Disciplina não encontrada no currículo desta classe/secção' });
    }
    res.json({ success: true, message: 'Configuração atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar "tem exame" da disciplina:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar configuração', error: err.message });
  }
};

// GET /schools/:schoolId/turmas/:turmaId/juris-exame
export const getJurisDaTurma = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const juris = await listarJurisDaTurma(schoolId, turmaId);
    res.json({ success: true, data: juris });
  } catch (err) {
    console.error('[v0] Erro ao listar júris da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar júris', error: err.message });
  }
};

// POST /schools/:schoolId/turmas/:turmaId/juris-exame/gerar
// Body: { tamanho?: number, forcar?: boolean }
export const postGerarJuris = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const { tamanho = 40, forcar = false } = req.body;
    const resultado = await gerarJurisAutomaticos(schoolId, turmaId, tamanho, !!forcar);
    if (resultado.erro) return res.status(400).json({ success: false, message: resultado.erro });
    await registrarAuditoria(req, {
      acao: 'juris_exame_gerados', entidadeTipo: 'juri_exame', entidadeId: turmaId,
      dadosNovos: { turma_id: turmaId, tamanho, forcar: !!forcar, total_juris: resultado.juris.length, criados: resultado.criados },
    });
    res.json({
      success: true,
      message: resultado.criados
        ? `${resultado.juris.length} júri(s) gerado(s) com sucesso.`
        : 'Esta turma já tinha júris gerados para o ano letivo corrente — nada foi alterado (use "forçar" para recriar).',
      data: resultado.juris,
    });
  } catch (err) {
    console.error('[v0] Erro ao gerar júris:', err);
    res.status(500).json({ success: false, message: 'Erro ao gerar júris', error: err.message });
  }
};

// DELETE /schools/:schoolId/juris-exame/:juriId
export const deleteJuri = async (req, res) => {
  try {
    const { schoolId, juriId } = req.params;
    const sucesso = await removerJuri(schoolId, juriId);
    if (!sucesso) return res.status(404).json({ success: false, message: 'Júri não encontrado' });
    await registrarAuditoria(req, { acao: 'juri_exame_removido', entidadeTipo: 'juri_exame', entidadeId: juriId });
    res.json({ success: true, message: 'Júri removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover júri:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover júri', error: err.message });
  }
};

// GET /schools/:schoolId/juris-exame/:juriId
export const getJuri = async (req, res) => {
  try {
    const { schoolId, juriId } = req.params;
    const dados = await montarDadosPautaExame(schoolId, juriId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });
    res.json({ success: true, ...dados });
  } catch (err) {
    console.error('[v0] Erro ao montar dados do júri:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar dados do júri', error: err.message });
  }
};

// PUT /schools/:schoolId/juris-exame/:juriId/membros/:studentId/comportamento
// Body: { valor: number|null }
export const putComportamentoMembro = async (req, res) => {
  try {
    const { schoolId, juriId, studentId } = req.params;
    const { valor } = req.body;
    const resultado = await atualizarComportamentoMembro(schoolId, juriId, studentId, valor);
    if (resultado.erro) return res.status(400).json({ success: false, message: resultado.erro });
    if (!resultado.sucesso) return res.status(404).json({ success: false, message: 'Membro não encontrado neste júri' });
    await registrarAuditoria(req, {
      acao: 'comportamento_pauta_exame_alterado', entidadeTipo: 'juri_membro', entidadeId: studentId,
      dadosNovos: { juri_id: juriId, comportamento: valor === '' ? null : valor },
    });
    res.json({ success: true, message: 'Comportamento atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar comportamento:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar comportamento', error: err.message });
  }
};

// PATCH /schools/:schoolId/juris-exame/:juriId/estado
export const patchEstadoJuri = async (req, res) => {
  try {
    const { schoolId, juriId } = req.params;
    const { estado } = req.body;
    const resultado = await atualizarEstadoJuri(schoolId, juriId, estado);
    if (resultado.erro) return res.status(400).json({ success: false, message: resultado.erro });
    if (resultado.naoEncontrado) return res.status(404).json({ success: false, message: 'Júri não encontrado' });
    await registrarAuditoria(req, {
      acao: 'estado_pauta_exame_alterado', entidadeTipo: 'juri_exame', entidadeId: juriId,
      dadosAntigos: { estado: resultado.estadoAnterior }, dadosNovos: { estado: resultado.estado },
    });
    res.json({ success: true, estado: resultado.estado, message: 'Estado da pauta atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar estado do júri:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar estado da pauta' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PDF — GET /schools/:schoolId/juris-exame/:juriId/pdf
// Reproduz o layout do modelo oficial: cabeçalho (República/Escola), título
// "PAUTA DE EXAME - ENSINO SECUNDÁRIO · JÚRI N · CLASSE · ANO LECTIVO",
// tabela Nº/Nome/Género × (NC | NE 1ªCha | NE 2ªCha | NF) por disciplina com
// exame (ou só NF para as que não têm) + Comportamento + MGC + Resultado,
// e rodapé com linhas de assinatura 1ª/2ª Chamada + observações + data do
// conselho — mesmo padrão técnico (PDFKit, A4 paisagem) de
// gerarPautaOficialPDF (gradeController.js).
// ═══════════════════════════════════════════════════════════════════════════
export const gerarPautaExamePDF = async (req, res) => {
  try {
    const { schoolId, juriId } = req.params;
    const dados = await montarDadosPautaExame(schoolId, juriId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });

    // `provincia` é garantida pela migração do perfil da escola; `distrito`
    // não existe em todas as instalações antigas e não pode quebrar o PDF.
    const escolaRows = await queryAsync(`SELECT name, provincia FROM schools WHERE id = ?`, [schoolId]);
    const escola = escolaRows[0] || {};
    const { juri, disciplinas, alunos, tem_dados_incompletos: temDadosIncompletos, usar_tolerancia_transicao_esg1: usaTolerancia } = dados;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pauta-exame-juri-${juri.numero}-${(juri.turma_nome || 'turma').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    doc.pipe(res);

    const larguraUtil = doc.page.width - 48;

    // ── Cabeçalho oficial ──────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#475569').text('República de Moçambique', { align: 'center' });
    if (escola.provincia) {
      doc.fontSize(7.5).font('Helvetica').fillColor('#475569')
        .text(`Serviço Distrital de Educação, Juventude e Tecnologia — ${escola.provincia}`, { align: 'center' });
    }
    doc.moveDown(0.25);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000000').text(escola.name || 'Escola', { align: 'center' });
    doc.moveDown(0.35);
    doc.fontSize(11.5).font('Helvetica-Bold').fillColor('#000000')
      .text(`PAUTA DE EXAME — ENSINO SECUNDÁRIO   ·   JÚRI ${String(juri.numero).padStart(2, '0')}   ·   ${juri.classe_nome || '—'}   ·   ANO LECTIVO ${juri.ano_letivo}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(8.5).font('Helvetica').fillColor('#334155')
      .text(`Turma: ${juri.turma_nome || '—'}    Data de emissão: ${new Date().toLocaleDateString('pt-PT')}`, { align: 'center' });
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(juri.estado === 'emitida' ? '#166534' : '#b45309')
      .text(`ESTADO DA PAUTA: ${(juri.estado || 'rascunho').toUpperCase()}`, { align: 'center' });
    if (temDadosIncompletos) {
      doc.moveDown(0.2);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#b45309').text(
        'ATENÇÃO: pelo menos um aluno tem avaliação contínua ainda incompleta nalguma disciplina — confirme os lançamentos antes de submeter esta pauta.',
        { align: 'center' }
      );
    }
    if (usaTolerancia) {
      doc.moveDown(0.2);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#155e75').text(
        'Tolerância de transição do 1.º Ciclo do ESG ativa: média geral mínima 10, até duas disciplinas entre 8 e 9, nenhuma abaixo de 8, Português e Matemática com mínimo 10.',
        { align: 'center' }
      );
    }
    doc.moveDown(0.35);
    doc.strokeColor('#94a3b8').lineWidth(1).moveTo(24, doc.y).lineTo(24 + larguraUtil, doc.y).stroke();
    doc.moveDown(0.35);

    // ── Layout das colunas ───────────────────────────────────────────────
    const colNumero = 16;
    const colNome = 118;
    const colGenero = 16;
    const colComportamento = 28;
    const colMGC = 22;
    const colResultado = 46;
    const larguraFixas = colNumero + colNome + colGenero + colComportamento + colMGC + colResultado;

    // Cada disciplina COM exame ocupa 4 sub-colunas (NC, NE 1ª, NE 2ª, NF);
    // sem exame, ocupa 1 (só NF).
    const totalSubColunas = disciplinas.reduce((s, d) => s + (d.tem_exame ? 4 : 1), 0);
    const colSub = Math.max((larguraUtil - larguraFixas) / totalSubColunas, 13);
    const fonte = totalSubColunas > 28 ? 5 : totalSubColunas > 18 ? 5.8 : 6.8;
    const fonteCabecalho = fonte + 0.5;

    const desenharCabecalhoTabela = () => {
      const yTopo = doc.y;
      const alturaCabecalho = 28;
      doc.rect(24, yTopo, larguraUtil, alturaCabecalho).fill('#1e293b');
      doc.fillColor('#ffffff').font('Helvetica-Bold');

      let x = 24;
      doc.fontSize(fonteCabecalho).text('Nº', x, yTopo + 10, { width: colNumero, align: 'center' }); x += colNumero;
      doc.text('Nome', x + 2, yTopo + 10, { width: colNome - 2 }); x += colNome;
      doc.text('G', x, yTopo + 10, { width: colGenero, align: 'center' }); x += colGenero;

      disciplinas.forEach((disc) => {
        const largura = (disc.tem_exame ? 4 : 1) * colSub;
        doc.fontSize(fonte).text(disc.nome.slice(0, 10), x + 1, yTopo + 2, { width: largura - 2, align: 'center' });
        if (disc.tem_exame) {
          doc.fontSize(fonte - 0.5);
          doc.text('NC', x, yTopo + 17, { width: colSub, align: 'center' });
          doc.text('NE1ª', x + colSub, yTopo + 17, { width: colSub, align: 'center' });
          doc.text('NE2ª', x + colSub * 2, yTopo + 17, { width: colSub, align: 'center' });
          doc.text('NF', x + colSub * 3, yTopo + 17, { width: colSub, align: 'center' });
        } else {
          doc.fontSize(fonte - 0.5).text('NF', x, yTopo + 17, { width: colSub, align: 'center' });
        }
        x += largura;
      });

      doc.fontSize(fonteCabecalho);
      doc.text('Comp.', x, yTopo + 10, { width: colComportamento, align: 'center' }); x += colComportamento;
      doc.text('MGC', x, yTopo + 10, { width: colMGC, align: 'center' }); x += colMGC;
      doc.text('Resultado', x, yTopo + 10, { width: colResultado, align: 'center' });

      doc.y = yTopo + alturaCabecalho;
    };

    desenharCabecalhoTabela();

    const alturaLinha = 14;
    alunos.forEach((aluno, i) => {
      if (doc.y + alturaLinha > doc.page.height - 100) {
        doc.addPage();
        doc.y = 24;
        desenharCabecalhoTabela();
      }
      const yLinha = doc.y;
      if (i % 2 === 1) doc.rect(24, yLinha, larguraUtil, alturaLinha).fill('#f8fafc');
      doc.fillColor('#1e293b').font('Helvetica').fontSize(fonte);

      let x = 24;
      doc.text(String(aluno.ordem), x, yLinha + 3, { width: colNumero, align: 'center' }); x += colNumero;
      doc.text(aluno.nome.slice(0, 32), x + 2, yLinha + 3, { width: colNome - 2 }); x += colNome;
      doc.text(aluno.genero || '—', x, yLinha + 3, { width: colGenero, align: 'center' }); x += colGenero;

      disciplinas.forEach((disc) => {
        const n = aluno.notas[disc.id] || {};
        const fmt = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2).replace(/\.00$/, ''));
        if (disc.tem_exame) {
          doc.text(fmt(n.nc), x, yLinha + 3, { width: colSub, align: 'center' });
          doc.text(n.ne_1a_chamada != null ? fmt(n.ne_1a_chamada) : '', x + colSub, yLinha + 3, { width: colSub, align: 'center' });
          doc.text(n.ne_2a_epoca != null ? fmt(n.ne_2a_epoca) : '—', x + colSub * 2, yLinha + 3, { width: colSub, align: 'center' });
          doc.font('Helvetica-Bold').text(fmt(n.nf), x + colSub * 3, yLinha + 3, { width: colSub, align: 'center' }); doc.font('Helvetica');
        } else {
          doc.font('Helvetica-Bold').text(fmt(n.nf), x, yLinha + 3, { width: colSub, align: 'center' }); doc.font('Helvetica');
        }
        x += (disc.tem_exame ? 4 : 1) * colSub;
      });

      doc.text(aluno.comportamento != null ? aluno.comportamento.toFixed(0) : '—', x, yLinha + 3, { width: colComportamento, align: 'center' }); x += colComportamento;
      doc.font('Helvetica-Bold').text(aluno.mgc != null ? String(aluno.mgc) : '—', x, yLinha + 3, { width: colMGC, align: 'center' }); doc.font('Helvetica'); x += colMGC;
      doc.text(aluno.excluido_por_faltas ? 'Excluído*' : (aluno.resultado || '—'), x, yLinha + 3, { width: colResultado, align: 'center' });

      doc.y = yLinha + alturaLinha;
    });

    doc.moveDown(0.6);
    doc.fontSize(6.5).font('Helvetica').fillColor('#64748b').text(
      `NC = Nota de Curso (avaliação contínua, sem exame). NE = Nota de Exame (1ª Chamada / 2ª Época). NF = Nota Final = NC×${(100 - dados.peso_exame)}% + NE×${dados.peso_exame}% (pesos configurados pela escola em Avaliação) — sem NE lançada, NF é uma projeção só com NC. MGC = Média Geral de Curso (arredondada). * Excluído por faltas (limite PPF: ${dados.faltas_max_ppf}).`,
      24, doc.y, { width: larguraUtil }
    );

    // ── Rodapé: assinaturas + observações + data do conselho ────────────
    if (doc.y > doc.page.height - 130) { doc.addPage(); doc.y = 24; }
    doc.moveDown(1.2);
    const yAss = doc.y;
    const largaAss = 200;
    doc.strokeColor('#334155').lineWidth(0.7)
      .moveTo(24, yAss).lineTo(24 + largaAss, yAss).stroke()
      .moveTo(24 + largaAss + 40, yAss).lineTo(24 + largaAss * 2 + 40, yAss).stroke();
    doc.fontSize(8).font('Helvetica').fillColor('#334155');
    doc.text('Assinatura 1ª Chamada', 24, yAss + 4, { width: largaAss, align: 'center' });
    doc.text('Assinatura 2ª Chamada', 24 + largaAss + 40, yAss + 4, { width: largaAss, align: 'center' });

    doc.moveDown(1.6);
    doc.fontSize(7.5).font('Helvetica').fillColor('#334155')
      .text('Observações: ______________________________________________________________________________________________', 24, doc.y, { width: larguraUtil });

    doc.moveDown(1.4);
    doc.fontSize(8).font('Helvetica').fillColor('#334155')
      .text('Data do Conselho: ____ / ____________________ / 20____', larguraUtil - 220, doc.y, { width: 220, align: 'right' });

    doc.end();
  } catch (err) {
    console.error('[v0] Erro ao gerar Pauta de Exame em PDF:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar Pauta de Exame em PDF', error: err.message });
  }
};

// GET /schools/:schoolId/juris-exame/:juriId/excel
export const gerarPautaExameExcel = async (req, res) => {
  try {
    const { schoolId, juriId } = req.params;
    const dados = await montarDadosPautaExame(schoolId, juriId);
    if (dados.erro) return res.status(404).json({ success: false, message: dados.erro });

    const escolaRows = await queryAsync('SELECT name, provincia FROM schools WHERE id = ?', [schoolId]);
    const escola = escolaRows[0] || {};
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Pauta de Exame');
    const { juri, disciplinas, alunos } = dados;

    const colunas = [
      { header: 'Nº', key: 'ordem', width: 8 },
      { header: 'Código', key: 'codigo_aluno', width: 18 },
      { header: 'Nome completo', key: 'nome', width: 34 },
      { header: 'Género', key: 'genero', width: 10 },
    ];
    disciplinas.forEach((disciplina) => {
      if (disciplina.tem_exame) {
        colunas.push(
          { header: `${disciplina.nome} - NC`, key: `d_${disciplina.id}_nc`, width: 14 },
          { header: `${disciplina.nome} - NE 1ª`, key: `d_${disciplina.id}_ne1`, width: 14 },
          { header: `${disciplina.nome} - NE 2ª`, key: `d_${disciplina.id}_ne2`, width: 14 },
          { header: `${disciplina.nome} - NF`, key: `d_${disciplina.id}_nf`, width: 14 },
        );
      } else {
        colunas.push({ header: `${disciplina.nome} - NF`, key: `d_${disciplina.id}_nf`, width: 14 });
      }
    });
    colunas.push(
      { header: 'Comportamento', key: 'comportamento', width: 16 },
      { header: 'MGC', key: 'mgc', width: 12 },
      { header: 'Faltas', key: 'faltas', width: 10 },
      { header: 'Resultado', key: 'resultado', width: 18 },
    );
    sheet.columns = colunas;

    const formatar = (valor) => valor === null || valor === undefined ? '' : Number(valor).toFixed(2).replace(/\.00$/, '');
    alunos.forEach((aluno) => {
      const linha = {
        ordem: aluno.ordem,
        codigo_aluno: aluno.codigo_aluno || '',
        nome: aluno.nome,
        genero: aluno.genero || '',
        comportamento: aluno.comportamento == null ? '' : formatar(aluno.comportamento),
        mgc: aluno.mgc == null ? '' : aluno.mgc,
        faltas: aluno.total_faltas || 0,
        resultado: aluno.excluido_por_faltas ? 'Excluído' : aluno.resultado || '',
      };
      disciplinas.forEach((disciplina) => {
        const nota = aluno.notas[disciplina.id] || {};
        linha[`d_${disciplina.id}_nc`] = formatar(nota.nc);
        linha[`d_${disciplina.id}_ne1`] = formatar(nota.ne_1a_chamada);
        linha[`d_${disciplina.id}_ne2`] = formatar(nota.ne_2a_epoca);
        linha[`d_${disciplina.id}_nf`] = formatar(nota.nf);
      });
      sheet.addRow(linha);
    });

    const cabecalho = sheet.getRow(1);
    cabecalho.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cabecalho.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cabecalho.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    sheet.insertRow(1, [`Pauta de Exame — ${escola.name || 'Escola'} | Júri ${String(juri.numero).padStart(2, '0')} | ${juri.turma_nome || ''} | Estado: ${(juri.estado || 'rascunho').toUpperCase()}`]);
    sheet.mergeCells(1, 1, 1, sheet.columnCount);
    sheet.getRow(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    sheet.getRow(1).alignment = { horizontal: 'center' };
    sheet.views = [{ state: 'frozen', ySplit: 2 }];
    const colunaFinal = sheet.getColumn(sheet.columnCount).letter;
    sheet.autoFilter = `A2:${colunaFinal}2`;

    const buffer = await workbook.xlsx.writeBuffer();
    const nomeArquivo = `pauta-exame-juri-${juri.numero}-${(juri.turma_nome || 'turma').replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[v0] Erro ao gerar Pauta de Exame em Excel:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar Pauta de Exame em Excel', error: err.message });
  }
};

import { construirReciboPagamento, construirReciboRenovacao, construirComprovativoMatricula } from '../services/pdfReceiptService.js';

/**
 * GET /schools/:schoolId/student-payments/:paymentId/recibo
 * Gera, em PDF, o comprovativo de um pagamento de mensalidade já efetuado
 * (student_payments com status = 'pago').
 *
 * v96 — a montagem do PDF em si foi extraída para
 * services/pdfReceiptService.js (devolve um Buffer), para poder ser
 * reaproveitada também pelo envio automático via WhatsApp
 * (services/notificacaoRelatorioService.js), sem duplicar o desenho do
 * documento. Este endpoint continua a devolver exatamente o mesmo PDF.
 */
export const gerarReciboPagamento = async (req, res) => {
  try {
    const { schoolId, paymentId } = req.params;
    const { buffer, numeroRecibo } = await construirReciboPagamento(schoolId, paymentId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${numeroRecibo}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[v0] Erro ao gerar recibo de pagamento:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao gerar recibo de pagamento', error: err.message });
    }
  }
};

/**
 * GET /schools/:schoolId/enrollment-history/:historyId/recibo
 * Gera, em PDF, o comprovativo de uma renovação de matrícula.
 */
export const gerarReciboRenovacao = async (req, res) => {
  try {
    const { schoolId, historyId } = req.params;
    const { buffer, numeroRecibo } = await construirReciboRenovacao(schoolId, historyId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-renovacao-${numeroRecibo}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[v0] Erro ao gerar recibo de renovação:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao gerar recibo de renovação', error: err.message });
    }
  }
};

/**
 * GET /schools/:schoolId/students/:studentId/comprovativo-matricula
 * Gera, em PDF, o comprovativo de matrícula de um aluno (v96 — o mesmo
 * documento enviado automaticamente ao encarregado por WhatsApp no momento
 * da inscrição).
 */
export const gerarComprovativoMatricula = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { buffer, numeroRecibo } = await construirComprovativoMatricula(schoolId, studentId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="matricula-${numeroRecibo}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[v0] Erro ao gerar comprovativo de matrícula:', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao gerar comprovativo de matrícula', error: err.message });
    }
  }
};

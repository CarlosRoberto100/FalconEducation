/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ANO LETIVO — camada HTTP fina
 * ─────────────────────────────────────────────────────────────────────────────
 * v55: toda a lógica foi movida para services/academicYearService.js (o
 * "serviço central de ano letivo" pedido na auditoria). Este ficheiro fica só
 * com os handlers Express e reexporta os helpers para não quebrar nenhum
 * import existente (attendanceController, disciplinarController,
 * gradeController, mensalidades.controller, renewalController,
 * studentController, etc. continuam a importar destes mesmos nomes).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import {
  getAnoLetivoAtivo,
  resolverAnoLetivoPorData,
  getAnoLetivoPorId,
  listarAnosLetivos,
  criarAnoLetivo,
  atualizarAnoLetivo,
  ativarAnoLetivo,
  removerAnoLetivo,
} from '../services/academicYearService.js';

// Reexportados para compatibilidade com todos os módulos que já importam
// estes helpers diretamente do controller.
export { getAnoLetivoAtivo, resolverAnoLetivoPorData, getAnoLetivoPorId };

// GET /schools/:schoolId/academic-years
export const getAcademicYears = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const anos = await listarAnosLetivos(schoolId);
    res.json({ success: true, data: anos });
  } catch (err) {
    console.error('[v0] Erro ao listar anos letivos:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar anos letivos', error: err.message });
  }
};

// GET /schools/:schoolId/academic-years/ativo
export const getAcademicYearAtivo = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const ano = await getAnoLetivoAtivo(schoolId);
    res.json({ success: true, data: ano });
  } catch (err) {
    console.error('[v0] Erro ao buscar ano letivo ativo:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar ano letivo ativo', error: err.message });
  }
};

// POST /schools/:schoolId/academic-years
export const createAcademicYear = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const id = await criarAnoLetivo(schoolId, req.body);
    res.status(201).json({ success: true, message: 'Ano letivo criado com sucesso', id });
  } catch (err) {
    console.error('[v0] Erro ao criar ano letivo:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Já existe um ano letivo com esse nome nesta escola' });
    }
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao criar ano letivo', error: err.message });
  }
};

// PUT /schools/:schoolId/academic-years/:yearId
export const updateAcademicYear = async (req, res) => {
  try {
    const { schoolId, yearId } = req.params;
    await atualizarAnoLetivo(schoolId, yearId, req.body);
    res.json({ success: true, message: 'Ano letivo atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar ano letivo:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao atualizar ano letivo', error: err.message });
  }
};

// POST /schools/:schoolId/academic-years/:yearId/ativar
export const setActiveAcademicYear = async (req, res) => {
  try {
    const { schoolId, yearId } = req.params;
    await ativarAnoLetivo(schoolId, yearId);
    res.json({ success: true, message: 'Ano letivo ativado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao ativar ano letivo:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao ativar ano letivo', error: err.message });
  }
};

// DELETE /schools/:schoolId/academic-years/:yearId
export const deleteAcademicYear = async (req, res) => {
  try {
    const { schoolId, yearId } = req.params;
    await removerAnoLetivo(schoolId, yearId);
    res.json({ success: true, message: 'Ano letivo removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover ano letivo:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao remover ano letivo', error: err.message });
  }
};

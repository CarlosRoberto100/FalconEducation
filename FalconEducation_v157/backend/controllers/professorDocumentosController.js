import db from '../config/db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { registrarAuditoria } from '../services/auditService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARMAZENAMENTO — mesmo padrão usado em documentos-alunos.
// ═══════════════════════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_UPLOADS = path.join(__dirname, '..', 'uploads', 'documentos-professores');

if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

const EXTENSOES_PERMITIDAS = /\.(pdf|doc|docx|jpg|jpeg|png|webp)$/i;
const TIPOS_VALIDOS = ['BI', 'CertificadoHabilitacoes', 'Contrato', 'CV', 'RegistoCriminal', 'Outro'];
const TIPOS_OBRIGATORIOS_POR_OMISSAO = ['BI', 'CertificadoHabilitacoes', 'Contrato'];
const ESTADOS_VALIDOS = ['valido', 'pendente_revisao', 'rejeitado'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PASTA_UPLOADS),
  filename: (req, file, cb) => {
    const nomeSeguro = `${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, nomeSeguro);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (EXTENSOES_PERMITIDAS.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('Tipo de ficheiro não permitido. Use PDF, Word ou imagem (jpg/png/webp).'));
  },
});

export const uploadDocumentoProfessorMiddleware = upload.single('arquivo');

const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

const columnExists = async (tabela, coluna) => {
  const rows = await queryAsync(
    `SELECT COUNT(*) as qtd FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tabela, coluna]
  );
  return rows[0]?.qtd > 0;
};

export const ensureTabelaExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS teacher_documentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      tipo VARCHAR(30) NOT NULL DEFAULT 'Outro',
      obrigatorio TINYINT(1) NOT NULL DEFAULT 0,
      titulo VARCHAR(150) NOT NULL,
      data_emissao DATE NULL,
      data_validade DATE NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'valido',
      observacao TEXT NULL,
      arquivo_nome_original VARCHAR(255) NOT NULL,
      arquivo_caminho VARCHAR(255) NOT NULL,
      arquivo_tamanho INT NULL,
      enviado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_school_teacher (school_id, teacher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

const apagarFicheiroDoDisco = (caminhoRelativo) => {
  if (!caminhoRelativo) return;
  const caminhoAbsoluto = path.join(PASTA_UPLOADS, path.basename(caminhoRelativo));
  fs.unlink(caminhoAbsoluto, (err) => {
    if (err && err.code !== 'ENOENT') console.error('[v0] Erro ao apagar documento do professor do disco:', err.message);
  });
};

// GET /schools/:schoolId/teachers/:teacherId/documentos
export const getDocumentosProfessor = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, teacherId } = req.params;
    const documentos = await queryAsync(
      `SELECT * FROM teacher_documentos WHERE school_id = ? AND teacher_id = ? ORDER BY created_at DESC`,
      [schoolId, teacherId]
    );
    res.json({ success: true, data: documentos });
  } catch (err) {
    console.error('[v0] Erro ao listar documentos do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar documentos do professor', error: err.message });
  }
};

// POST /schools/:schoolId/teachers/:teacherId/documentos
export const uploadDocumentoProfessor = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, teacherId } = req.params;
    const { tipo, titulo, observacao, data_emissao, data_validade, obrigatorio } = req.body;

    if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum ficheiro enviado' });
    if (!titulo?.trim()) {
      apagarFicheiroDoDisco(req.file.filename);
      return res.status(400).json({ success: false, message: 'O título do documento é obrigatório' });
    }
    const tipoFinal = TIPOS_VALIDOS.includes(tipo) ? tipo : 'Outro';
    const obrigatorioFinal = obrigatorio !== undefined
      ? (obrigatorio === 'true' || obrigatorio === '1' || obrigatorio === true ? 1 : 0)
      : (TIPOS_OBRIGATORIOS_POR_OMISSAO.includes(tipoFinal) ? 1 : 0);

    const inserido = await queryAsync(
      `INSERT INTO teacher_documentos
         (school_id, teacher_id, tipo, obrigatorio, titulo, data_emissao, data_validade, observacao, arquivo_nome_original, arquivo_caminho, arquivo_tamanho, enviado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        schoolId, teacherId, tipoFinal, obrigatorioFinal, titulo.trim(),
        data_emissao || null, data_validade || null, observacao || null,
        req.file.originalname, req.file.filename, req.file.size,
        req.user?.nome || req.user?.email || null,
      ]
    );
    res.status(201).json({ success: true, message: 'Documento carregado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao carregar documento do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar documento do professor', error: err.message });
  }
};

// PATCH /schools/:schoolId/professores-documentos/:documentoId
export const editarDocumentoProfessor = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, documentoId } = req.params;
    const { titulo, observacao, data_emissao, data_validade, obrigatorio, estado } = req.body;

    const [documento] = await queryAsync(`SELECT id FROM teacher_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
    if (!documento) return res.status(404).json({ success: false, message: 'Documento não encontrado' });

    if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ success: false, message: `Estado inválido. Use um de: ${ESTADOS_VALIDOS.join(', ')}` });
    }

    const campos = [];
    const valores = [];
    if (titulo !== undefined) { campos.push('titulo = ?'); valores.push(titulo.trim()); }
    if (observacao !== undefined) { campos.push('observacao = ?'); valores.push(observacao || null); }
    if (data_emissao !== undefined) { campos.push('data_emissao = ?'); valores.push(data_emissao || null); }
    if (data_validade !== undefined) { campos.push('data_validade = ?'); valores.push(data_validade || null); }
    if (obrigatorio !== undefined) { campos.push('obrigatorio = ?'); valores.push(obrigatorio === 'true' || obrigatorio === '1' || obrigatorio === true ? 1 : 0); }
    if (estado !== undefined) { campos.push('estado = ?'); valores.push(estado); }

    if (campos.length === 0) return res.status(400).json({ success: false, message: 'Nada para atualizar' });

    valores.push(documentoId, schoolId);
    await queryAsync(`UPDATE teacher_documentos SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);
    res.json({ success: true, message: 'Documento atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao editar documento do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao editar documento do professor', error: err.message });
  }
};

// GET /schools/:schoolId/professores-documentos-vencendo?dias=30
export const getDocumentosProfessorVencendo = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId } = req.params;
    const dias = Number.parseInt(req.query.dias, 10) || 30;

    const registros = await queryAsync(
      `
        SELECT
          d.id, d.tipo, d.titulo, d.data_validade,
          d.teacher_id, t.nome as professor_nome,
          DATEDIFF(d.data_validade, CURDATE()) as dias_restantes
        FROM teacher_documentos d
        LEFT JOIN teachers t ON t.id = d.teacher_id
        WHERE d.school_id = ?
          AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= ?
          AND (t.ativo = 1 OR t.ativo IS NULL)
        ORDER BY d.data_validade ASC
        LIMIT 200
      `,
      [schoolId, dias]
    );

    res.json({
      success: true,
      total: registros.length,
      vencidos_qtd: registros.filter((r) => r.dias_restantes < 0).length,
      a_vencer_qtd: registros.filter((r) => r.dias_restantes >= 0).length,
      data: registros.map((r) => ({ ...r, vencido: r.dias_restantes < 0 })),
    });
  } catch (err) {
    console.error('[v0] Erro ao listar documentos de professores a vencer:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar documentos de professores a vencer', error: err.message });
  }
};

// DELETE /schools/:schoolId/professores-documentos/:documentoId
export const deleteDocumentoProfessor = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, documentoId } = req.params;
    const [documento] = await queryAsync(`SELECT * FROM teacher_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
    if (!documento) return res.status(404).json({ success: false, message: 'Documento não encontrado' });

    await queryAsync(`DELETE FROM teacher_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
    apagarFicheiroDoDisco(documento.arquivo_caminho);
    await registrarAuditoria(req, {
      acao: 'documento_professor_removido', entidadeTipo: 'teacher_documento', entidadeId: documentoId, dadosAntigos: documento,
    });
    res.json({ success: true, message: 'Documento removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover documento do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover documento do professor', error: err.message });
  }
};

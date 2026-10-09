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
// ARMAZENAMENTO — mesmo padrão usado na Biblioteca (uploads/documentos-alunos,
// servidos como estáticos a partir de /uploads — ver app.js).
// ═══════════════════════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_UPLOADS = path.join(__dirname, '..', 'uploads', 'documentos-alunos');

if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

const EXTENSOES_PERMITIDAS = /\.(pdf|doc|docx|jpg|jpeg|png|webp)$/i;
const TIPOS_VALIDOS = ['BI', 'Certidao', 'Foto', 'Declaracao', 'Contrato', 'Autorizacao', 'Boletim', 'Outro'];
// Tipos considerados obrigatórios por omissão (o admin pode marcar/desmarcar
// qualquer documento como obrigatório individualmente no upload).
const TIPOS_OBRIGATORIOS_POR_OMISSAO = ['BI', 'Certidao', 'Foto', 'Declaracao'];
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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por documento
  fileFilter: (req, file, cb) => {
    if (EXTENSOES_PERMITIDAS.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('Tipo de ficheiro não permitido. Use PDF, Word ou imagem (jpg/png/webp).'));
  },
});

export const uploadDocumentoMiddleware = upload.single('arquivo');

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
    CREATE TABLE IF NOT EXISTS student_documentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      tipo VARCHAR(30) NOT NULL DEFAULT 'Outro',
      titulo VARCHAR(150) NOT NULL,
      observacao TEXT NULL,
      arquivo_nome_original VARCHAR(255) NOT NULL,
      arquivo_caminho VARCHAR(255) NOT NULL,
      arquivo_tamanho INT NULL,
      enviado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── MÓDULO "DOCUMENTAÇÃO ESCOLAR": validade, obrigatoriedade e estado de
  // verificação — adicionados via ALTER idempotente para não quebrar bases
  // já existentes (mesmo padrão usado em gradeController.js). ────────────
  if (!(await columnExists('student_documentos', 'obrigatorio'))) {
    await queryAsync(`ALTER TABLE student_documentos ADD COLUMN obrigatorio TINYINT(1) NOT NULL DEFAULT 0 AFTER tipo`);
  }
  if (!(await columnExists('student_documentos', 'data_emissao'))) {
    await queryAsync(`ALTER TABLE student_documentos ADD COLUMN data_emissao DATE NULL AFTER titulo`);
  }
  if (!(await columnExists('student_documentos', 'data_validade'))) {
    await queryAsync(`ALTER TABLE student_documentos ADD COLUMN data_validade DATE NULL AFTER data_emissao`);
  }
  if (!(await columnExists('student_documentos', 'estado'))) {
    await queryAsync(`ALTER TABLE student_documentos ADD COLUMN estado VARCHAR(20) NOT NULL DEFAULT 'valido' AFTER data_validade`);
  }
  if (!(await columnExists('student_documentos', 'updated_at'))) {
    await queryAsync(`ALTER TABLE student_documentos ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`);
  }
});

const apagarFicheiroDoDisco = (caminhoRelativo) => {
  if (!caminhoRelativo) return;
  const caminhoAbsoluto = path.join(PASTA_UPLOADS, path.basename(caminhoRelativo));
  fs.unlink(caminhoAbsoluto, (err) => {
    if (err && err.code !== 'ENOENT') console.error('[v0] Erro ao apagar documento do aluno do disco:', err.message);
  });
};

// GET /schools/:schoolId/students/:studentId/documentos
export const getDocumentosAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const documentos = await queryAsync(
      `SELECT * FROM student_documentos WHERE school_id = ? AND student_id = ? ORDER BY created_at DESC`,
      [schoolId, studentId]
    );
    res.json({ success: true, data: documentos });
  } catch (err) {
    console.error('[v0] Erro ao listar documentos do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar documentos do aluno', error: err.message });
  }
};

// POST /schools/:schoolId/students/:studentId/documentos  (multipart/form-data: arquivo, tipo, titulo, observacao, data_emissao, data_validade, obrigatorio)
export const uploadDocumentoAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const { tipo, titulo, observacao, data_emissao, data_validade, obrigatorio } = req.body;

    if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum ficheiro enviado' });
    if (!titulo?.trim()) {
      apagarFicheiroDoDisco(req.file.filename);
      return res.status(400).json({ success: false, message: 'O título do documento é obrigatório' });
    }
    const tipoFinal = TIPOS_VALIDOS.includes(tipo) ? tipo : 'Outro';
    // Se o admin não indicar explicitamente, assume-se obrigatório para os
    // tipos de documento essenciais (BI, Certidão, Foto, Declaração).
    const obrigatorioFinal = obrigatorio !== undefined
      ? (obrigatorio === 'true' || obrigatorio === '1' || obrigatorio === true ? 1 : 0)
      : (TIPOS_OBRIGATORIOS_POR_OMISSAO.includes(tipoFinal) ? 1 : 0);

    const inserido = await queryAsync(
      `INSERT INTO student_documentos
         (school_id, student_id, tipo, obrigatorio, titulo, data_emissao, data_validade, observacao, arquivo_nome_original, arquivo_caminho, arquivo_tamanho, enviado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        schoolId, studentId, tipoFinal, obrigatorioFinal, titulo.trim(),
        data_emissao || null, data_validade || null, observacao || null,
        req.file.originalname, req.file.filename, req.file.size,
        req.user?.nome || req.user?.email || null,
      ]
    );
    res.status(201).json({ success: true, message: 'Documento carregado com sucesso', id: inserido.insertId });
    registrarAuditoria(req, {
      acao: 'documento_aluno_criado', entidadeTipo: 'student_documento', entidadeId: inserido.insertId,
      dadosNovos: { student_id: studentId, tipo: tipoFinal, titulo: titulo.trim(), data_validade: data_validade || null },
    });
  } catch (err) {
    console.error('[v0] Erro ao carregar documento do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar documento do aluno', error: err.message });
  }
};

// PATCH /schools/:schoolId/documentos/:documentoId  (editar metadados sem reenviar o ficheiro)
export const editarDocumentoAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, documentoId } = req.params;
    const { titulo, observacao, data_emissao, data_validade, obrigatorio, estado } = req.body;

    const [documento] = await queryAsync(`SELECT * FROM student_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
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
    await queryAsync(`UPDATE student_documentos SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);
    await registrarAuditoria(req, {
      acao: 'documento_aluno_editado', entidadeTipo: 'student_documento', entidadeId: documentoId,
      dadosAntigos: documento, dadosNovos: { titulo, observacao, data_emissao, data_validade, obrigatorio, estado },
    });
    res.json({ success: true, message: 'Documento atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao editar documento do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao editar documento do aluno', error: err.message });
  }
};

// GET /schools/:schoolId/documentos-vencendo?dias=30
// Alerta de "Documentos a expirar" — lista, em toda a escola, os documentos
// com data_validade preenchida que já venceram ou vencem dentro de N dias
// (padrão: 30), mais próximo do vencimento primeiro.
export const getDocumentosVencendo = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId } = req.params;
    const dias = Number.parseInt(req.query.dias, 10) || 30;

    const registros = await queryAsync(
      `
        SELECT
          d.id, d.tipo, d.titulo, d.data_validade, d.estado,
          d.student_id, s.nome as aluno_nome, s.codigo_aluno,
          DATEDIFF(d.data_validade, CURDATE()) as dias_restantes
        FROM student_documentos d
        LEFT JOIN students s ON s.id = d.student_id
        WHERE d.school_id = ?
          AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= ?
          AND (s.ativo = 1 OR s.ativo IS NULL)
        ORDER BY d.data_validade ASC
        LIMIT 200
      `,
      [schoolId, dias]
    );

    const vencidos = registros.filter((r) => r.dias_restantes < 0);
    const aVencer = registros.filter((r) => r.dias_restantes >= 0);

    res.json({
      success: true,
      total: registros.length,
      vencidos_qtd: vencidos.length,
      a_vencer_qtd: aVencer.length,
      data: registros.map((r) => ({
        id: r.id,
        tipo: r.tipo,
        titulo: r.titulo,
        student_id: r.student_id,
        aluno_nome: r.aluno_nome,
        codigo_aluno: r.codigo_aluno,
        data_validade: r.data_validade,
        dias_restantes: r.dias_restantes,
        vencido: r.dias_restantes < 0,
      })),
    });
  } catch (err) {
    console.error('[v0] Erro ao listar documentos a vencer:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar documentos a vencer', error: err.message });
  }
};

// DELETE /schools/:schoolId/documentos/:documentoId
export const deleteDocumentoAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, documentoId } = req.params;
    const [documento] = await queryAsync(`SELECT * FROM student_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
    if (!documento) return res.status(404).json({ success: false, message: 'Documento não encontrado' });

    await queryAsync(`DELETE FROM student_documentos WHERE id = ? AND school_id = ?`, [documentoId, schoolId]);
    apagarFicheiroDoDisco(documento.arquivo_caminho);
    await registrarAuditoria(req, {
      acao: 'documento_aluno_removido', entidadeTipo: 'student_documento', entidadeId: documentoId, dadosAntigos: documento,
    });
    res.json({ success: true, message: 'Documento removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover documento do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover documento do aluno', error: err.message });
  }
};

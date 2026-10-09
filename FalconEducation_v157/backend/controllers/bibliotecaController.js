import db from '../config/db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARMAZENAMENTO DOS FICHEIROS — guardados em disco, em backend/uploads/biblioteca,
// e servidos como estáticos a partir de /uploads (ver app.js). Cada material pode
// ser um ficheiro enviado (livro em PDF, ficha, imagem, etc.) OU um link externo
// (ex.: Google Drive/YouTube) — pelo menos um dos dois é obrigatório.
// ═══════════════════════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_UPLOADS = path.join(__dirname, '..', 'uploads', 'biblioteca');

if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

const EXTENSOES_PERMITIDAS = /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|jpg|jpeg|png|mp4|mp3|zip|rar)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PASTA_UPLOADS),
  filename: (req, file, cb) => {
    const nomeSeguro = `${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, nomeSeguro);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40MB por ficheiro
  fileFilter: (req, file, cb) => {
    if (EXTENSOES_PERMITIDAS.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de ficheiro não permitido. Use PDF, Word, PowerPoint, Excel, imagem, áudio, vídeo ou ZIP.'));
    }
  },
});

// Middleware exportado para ser usado diretamente na rota de criação/edição
export const uploadMaterialMiddleware = upload.single('arquivo');

// ═══════════════════════════════════════════════════════════════════════════════
// TABELA (auto-migração — mesmo padrão usado em outros controllers do projeto)
// ═══════════════════════════════════════════════════════════════════════════════
// Cache simples em memória: cada "ensureXxx" migra a base de dados (CREATE
// TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN se faltar) — são operações
// idempotentes, mas não precisam de correr em CADA pedido. Com memoize(),
// corre uma vez (a primeira chamada depois de o servidor arrancar) e todas as
// chamadas seguintes ficam instantâneas, reduzindo uma ida à base de dados por
// pedido em todas as rotas que dependem destas tabelas.
const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

export const ensureTabelaBibliotecaExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS biblioteca_materiais (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      classe_id INT NULL,
      titulo VARCHAR(150) NOT NULL,
      tipo VARCHAR(30) NOT NULL DEFAULT 'Outro',
      descricao TEXT NULL,
      arquivo_nome_original VARCHAR(255) NULL,
      arquivo_caminho VARCHAR(255) NULL,
      arquivo_tamanho INT NULL,
      link_externo VARCHAR(500) NULL,
      publicado_por VARCHAR(150) NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_school (school_id),
      KEY idx_classe (classe_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

const apagarFicheiroDoDisco = (caminhoRelativo) => {
  if (!caminhoRelativo) return;
  const caminhoAbsoluto = path.join(PASTA_UPLOADS, path.basename(caminhoRelativo));
  fs.unlink(caminhoAbsoluto, (err) => {
    if (err && err.code !== 'ENOENT') console.error('[v0] Erro ao apagar ficheiro da biblioteca:', err.message);
  });
};

// v78 — se o admin colar só "drive.google.com/xyz" (sem "https://"), o link
// vira um caminho RELATIVO ao próprio FalconEducation quando clicado (ex.:
// https://app.falconeducation.co.mz/drive.google.com/xyz), o que nunca abre
// o material. Normaliza para sempre ter um protocolo explícito.
const normalizarLinkExterno = (link) => {
  const limpo = (link || '').trim();
  if (!limpo) return null;
  return /^https?:\/\//i.test(limpo) ? limpo : `https://${limpo}`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /schools/:schoolId/biblioteca — lista materiais, com filtros opcionais por
// classe (?classe_id=) e tipo (?tipo=) e pesquisa por título (?pesquisa=).
// Materiais com classe_id NULL contam como "Todas as Classes" e aparecem sempre,
// independentemente do filtro de classe escolhido.
// ═══════════════════════════════════════════════════════════════════════════════
export const getMateriaisBiblioteca = async (req, res) => {
  try {
    await ensureTabelaBibliotecaExists();
    const { schoolId } = req.params;
    const { classe_id: classeId, tipo, pesquisa, limit = 60, offset = 0 } = req.query;

    const condicoes = ['bm.school_id = ?', 'bm.ativo = 1'];
    const parametros = [schoolId];

    if (classeId) {
      condicoes.push('(bm.classe_id = ? OR bm.classe_id IS NULL)');
      parametros.push(classeId);
    }
    if (tipo) {
      condicoes.push('bm.tipo = ?');
      parametros.push(tipo);
    }
    if (pesquisa && pesquisa.trim()) {
      condicoes.push('(bm.titulo LIKE ? OR bm.descricao LIKE ?)');
      parametros.push(`%${pesquisa.trim()}%`, `%${pesquisa.trim()}%`);
    }

    const totalRows = await queryAsync(
      `SELECT COUNT(*) as total FROM biblioteca_materiais bm WHERE ${condicoes.join(' AND ')}`,
      parametros
    );
    const total = totalRows[0]?.total || 0;

    const limiteNum = Math.min(parseInt(limit, 10) || 60, 200);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    const materiais = await queryAsync(
      `
        SELECT bm.*, c.nome as classe_nome
        FROM biblioteca_materiais bm
        LEFT JOIN classes c ON c.id = bm.classe_id
        WHERE ${condicoes.join(' AND ')}
        ORDER BY bm.created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...parametros, limiteNum, offsetNum]
    );

    const materiaisComUrl = materiais.map((m) => ({
      ...m,
      arquivo_url: m.arquivo_caminho ? `/uploads/biblioteca/${m.arquivo_caminho}` : null,
    }));

    res.json({
      success: true,
      data: materiaisComUrl,
      paginacao: { total, limit: limiteNum, offset: offsetNum, tem_mais: offsetNum + materiaisComUrl.length < total },
    });
  } catch (err) {
    console.error('[v0] Erro ao listar materiais da biblioteca:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar materiais da biblioteca', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /schools/:schoolId/biblioteca — publica um novo material (ficheiro
// enviado via multipart/form-data e/ou link externo — pelo menos um dos dois).
// ═══════════════════════════════════════════════════════════════════════════════
export const criarMaterialBiblioteca = async (req, res) => {
  try {
    await ensureTabelaBibliotecaExists();
    const { schoolId } = req.params;
    const { titulo, tipo, descricao, classe_id: classeId, link_externo: linkExterno, publicado_por: publicadoPor } = req.body;

    if (!titulo || !titulo.trim()) {
      if (req.file) apagarFicheiroDoDisco(req.file.filename);
      return res.status(400).json({ success: false, message: 'O título do material é obrigatório' });
    }
    if (!req.file && !(linkExterno && linkExterno.trim())) {
      return res.status(400).json({ success: false, message: 'Anexe um ficheiro ou indique um link externo' });
    }

    const classeIdFinal = classeId && classeId !== 'todas' ? classeId : null;

    const inserido = await queryAsync(
      `
        INSERT INTO biblioteca_materiais
          (school_id, classe_id, titulo, tipo, descricao, arquivo_nome_original, arquivo_caminho, arquivo_tamanho, link_externo, publicado_por, ativo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
      `,
      [
        schoolId,
        classeIdFinal,
        titulo.trim(),
        tipo || 'Outro',
        descricao || null,
        req.file ? req.file.originalname : null,
        req.file ? req.file.filename : null,
        req.file ? req.file.size : null,
        linkExterno && linkExterno.trim() ? normalizarLinkExterno(linkExterno) : null,
        publicadoPor || null,
      ]
    );

    res.status(201).json({ success: true, message: 'Material publicado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao publicar material da biblioteca:', err);
    if (req.file) apagarFicheiroDoDisco(req.file.filename);
    res.status(500).json({ success: false, message: 'Erro ao publicar material', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /schools/:schoolId/biblioteca/:materialId — edita metadados (e, opcional-
// mente, substitui o ficheiro/link). Não obriga a reenviar ficheiro.
// ═══════════════════════════════════════════════════════════════════════════════
export const atualizarMaterialBiblioteca = async (req, res) => {
  try {
    await ensureTabelaBibliotecaExists();
    const { schoolId, materialId } = req.params;
    const { titulo, tipo, descricao, classe_id: classeId, link_externo: linkExterno } = req.body;

    const existentes = await queryAsync(`SELECT * FROM biblioteca_materiais WHERE id = ? AND school_id = ?`, [materialId, schoolId]);
    if (existentes.length === 0) {
      if (req.file) apagarFicheiroDoDisco(req.file.filename);
      return res.status(404).json({ success: false, message: 'Material não encontrado' });
    }
    const atual = existentes[0];

    const classeIdFinal = classeId !== undefined ? (classeId && classeId !== 'todas' ? classeId : null) : atual.classe_id;

    // Se foi enviado um novo ficheiro, substitui o anterior (apaga o antigo do disco)
    let arquivoNome = atual.arquivo_nome_original;
    let arquivoCaminho = atual.arquivo_caminho;
    let arquivoTamanho = atual.arquivo_tamanho;
    if (req.file) {
      if (atual.arquivo_caminho) apagarFicheiroDoDisco(atual.arquivo_caminho);
      arquivoNome = req.file.originalname;
      arquivoCaminho = req.file.filename;
      arquivoTamanho = req.file.size;
    }

    const linkExternoFinal = linkExterno !== undefined ? normalizarLinkExterno(linkExterno) : atual.link_externo;

    // v78 — antes era possível, ao editar, limpar o link externo sem enviar
    // um ficheiro novo (ou vice-versa nalgum fluxo futuro), deixando um
    // material sem ficheiro E sem link: aparecia na biblioteca mas não tinha
    // nada para abrir. A mesma regra do "criar" (pelo menos um dos dois) tem
    // de valer também na edição.
    if (!arquivoCaminho && !linkExternoFinal) {
      if (req.file) apagarFicheiroDoDisco(req.file.filename);
      return res.status(400).json({ success: false, message: 'O material precisa de ter um ficheiro ou um link externo — não pode ficar sem nenhum dos dois.' });
    }

    await queryAsync(
      `
        UPDATE biblioteca_materiais SET
          titulo = ?, tipo = ?, descricao = ?, classe_id = ?,
          arquivo_nome_original = ?, arquivo_caminho = ?, arquivo_tamanho = ?,
          link_externo = ?, updated_at = NOW()
        WHERE id = ? AND school_id = ?
      `,
      [
        titulo?.trim() || atual.titulo,
        tipo || atual.tipo,
        descricao !== undefined ? descricao : atual.descricao,
        classeIdFinal,
        arquivoNome,
        arquivoCaminho,
        arquivoTamanho,
        linkExternoFinal,
        materialId,
        schoolId,
      ]
    );

    res.json({ success: true, message: 'Material atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar material da biblioteca:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar material', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /schools/:schoolId/biblioteca/:materialId
// ═══════════════════════════════════════════════════════════════════════════════
export const excluirMaterialBiblioteca = async (req, res) => {
  try {
    await ensureTabelaBibliotecaExists();
    const { schoolId, materialId } = req.params;

    const existentes = await queryAsync(`SELECT arquivo_caminho FROM biblioteca_materiais WHERE id = ? AND school_id = ?`, [materialId, schoolId]);
    if (existentes.length === 0) {
      return res.status(404).json({ success: false, message: 'Material não encontrado' });
    }

    await queryAsync(`DELETE FROM biblioteca_materiais WHERE id = ? AND school_id = ?`, [materialId, schoolId]);
    if (existentes[0].arquivo_caminho) apagarFicheiroDoDisco(existentes[0].arquivo_caminho);

    res.json({ success: true, message: 'Material removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao excluir material da biblioteca:', err);
    res.status(500).json({ success: false, message: 'Erro ao excluir material', error: err.message });
  }
};

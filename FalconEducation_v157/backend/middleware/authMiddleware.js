import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/jwt.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * MIDDLEWARE DE AUTENTICAÇÃO
 * Verifica se o token JWT é válido
 * ═══════════════════════════════════════════════════════════════
 */

export const verifyToken = (req, res, next) => {
  try {
    // Pegar token do header Authorization
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token não fornecido'
      });
    }

    // Verificar e decodificar token
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('[v0] Erro na autenticação:', error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expirado'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido'
      });
    }

    res.status(401).json({
      success: false,
      message: 'Erro na autenticação',
      error: error.message
    });
  }
};

/**
 * Verificar se usuário é admin
 */
export const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Acesso negado. Apenas administradores.'
    });
  }
  next();
};

/**
 * Verificar se usuário pertence à escola
 */
export const verifySchoolAccess = (req, res, next) => {
  const schoolIdFromParam = req.params.schoolId;
  
  if (!req.user || req.user.school_id !== parseInt(schoolIdFromParam)) {
    return res.status(403).json({
      success: false,
      message: 'Acesso negado. Você não pertence a esta escola.'
    });
  }
  
  next();
};

/**
 * v80 — Verificar se o token pertence a um professor (Área do Professor).
 * As rotas protegidas por este middleware nunca recebem um :teacherId na
 * URL — o professor só consegue ver/alterar os SEUS próprios dados,
 * identificados sempre a partir de req.user.id (o token), nunca de um
 * parâmetro que o cliente poderia manipular para tentar ver dados de
 * outro professor.
 */
export const verifyTeacherRole = (req, res, next) => {
  if (!req.user || req.user.role !== 'teacher') {
    return res.status(403).json({
      success: false,
      message: 'Acesso negado. Esta área é exclusiva para professores.'
    });
  }
  next();
};

/**
 * v82 — Mesmo princípio do verifyTeacherRole, mas para a Área do Aluno: o
 * aluno só consegue ver os SEUS próprios dados, identificados sempre a
 * partir de req.user.id, nunca de um :studentId na URL.
 */
export const verifyStudentRole = (req, res, next) => {
  if (!req.user || req.user.role !== 'student') {
    return res.status(403).json({
      success: false,
      message: 'Acesso negado. Esta área é exclusiva para alunos.'
    });
  }
  next();
};

/**
 * v59 — Autenticação para /uploads (ficheiros estáticos: documentos de
 * alunos, professores, funcionários, biblioteca). Antes, /uploads era
 * servido com express.static sem NENHUMA autenticação — qualquer pessoa
 * com a URL (BI, certidões, contratos...) conseguia aceder, sem login.
 *
 * Os links do frontend são <a href> abertos numa nova aba (target="_blank"),
 * então o browser não consegue anexar um header Authorization nessa
 * navegação — por isso este middleware aceita o token tanto no header
 * (uso normal via fetch/afetch) como num parâmetro ?token= (uso em links
 * diretos). Continua a exigir sessão válida; só não valida ainda a que
 * escola cada ficheiro pertence (isso exigiria mapear cada nome de
 * ficheiro de volta à escola dona na base de dados).
 */
export const verifyTokenUploads = (req, res, next) => {
  try {
    const tokenHeader = req.headers.authorization?.split(' ')[1];
    const token = tokenHeader || req.query.token;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token não fornecido' });
    }

    jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expirado' });
    }
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
};

/**
 * Verificar se o token pertence a um super admin (gestão da plataforma:
 * escolas, admins de escola, pagamentos das escolas, relatórios globais,
 * configurações do sistema, utilizadores). Deve ser usado sempre depois de
 * verifyToken, que já preenche req.user a partir do JWT.
 */
export const verifySuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      message: 'Acesso negado. Apenas o super administrador pode aceder a este recurso.'
    });
  }
  next();
};